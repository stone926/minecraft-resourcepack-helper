import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  combinedVsixRuntimeEntries,
  combinedVsixRuntimeSourceMaps,
  semanticJsonHash
} from "./combined-vsix-report.mjs";
import { readVsixArchiveMetrics } from "./vsix-archive-metrics.mjs";

export async function captureCombinedVsixModeEvidence(options) {
  const stageRoot = path.join(options.repositoryRoot, "dist", "vsix-stage", "main");
  const stageManifestFile = path.join(
    options.repositoryRoot,
    "dist",
    "vsix-stage",
    "main.contents.json"
  );
  const stage = readAndVerifyStage(stageRoot, stageManifestFile);
  const archive = await readVsixArchiveMetrics(options.artifactFile, {
    captureEntry: entryPath => entryPath === "extension/package.json"
      || (entryPath.startsWith("extension/") && entryPath.endsWith(".json"))
      || Object.values(combinedVsixRuntimeEntries).some(
        runtimePath => entryPath === `extension/${runtimePath}`
      )
      || combinedVsixRuntimeSourceMaps.some(mapPath => entryPath === `extension/${mapPath}`)
  });
  verifyStageIsPackaged(stage, archive);
  const jsonAssets = stage.jsonAssets.map(jsonAsset => {
    const archivePath = `extension/${jsonAsset.path}`;
    const packagedBytes = archive.capturedEntries[`extension/${jsonAsset.path}`];
    const metadata = archive.entries.find(entry => entry.path === archivePath && !entry.directory);
    if (!packagedBytes || !metadata || sha256(packagedBytes) !== jsonAsset.contentSha256
      || metadata.installedBytes !== jsonAsset.bytes) {
      throw new Error(`${options.mode} VSIX JSON differs from the verified stage: ${jsonAsset.path}`);
    }
    return Object.freeze({
      ...jsonAsset,
      vsixCompressedBytes: metadata.compressedBytes,
      installedBytes: metadata.installedBytes
    });
  });
  const manifestBytes = archive.capturedEntries["extension/package.json"];
  if (!manifestBytes) {
    throw new Error(`${options.mode} VSIX publish manifest was not captured.`);
  }
  const stagedManifestBytes = readFileSync(path.join(stageRoot, "package.json"));
  if (sha256(manifestBytes) !== sha256(stagedManifestBytes)) {
    throw new Error(`${options.mode} VSIX publish manifest differs from the verified stage.`);
  }
  const manifestValue = parseJson(manifestBytes, `${options.mode} extension/package.json`);
  const runtimeEntries = {};
  for (const [id, runtimePath] of Object.entries(combinedVsixRuntimeEntries)) {
    const archivePath = `extension/${runtimePath}`;
    const metadata = archive.entries.find(entry => entry.path === archivePath && !entry.directory);
    const archiveBytes = archive.capturedEntries[archivePath];
    const rawFile = path.join(options.repositoryRoot, ...runtimePath.split("/"));
    if (!metadata || !archiveBytes || !existsSync(rawFile)) {
      throw new Error(`${options.mode} runtime entry is missing: ${runtimePath}`);
    }
    const rawBytes = readFileSync(rawFile);
    const rawHash = sha256(rawBytes);
    if (rawHash !== sha256(archiveBytes)) {
      throw new Error(`${options.mode} VSIX runtime bytes differ from the built entry: ${runtimePath}`);
    }
    runtimeEntries[id] = Object.freeze({
      path: runtimePath,
      rawBytes: rawBytes.length,
      vsixCompressedBytes: metadata.compressedBytes,
      installedBytes: metadata.installedBytes,
      sha256: rawHash
    });
  }

  const sourceMapFiles = combinedVsixRuntimeSourceMaps.map(mapPath => {
    const absoluteMap = path.join(options.repositoryRoot, ...mapPath.split("/"));
    if (!existsSync(absoluteMap) || !statSync(absoluteMap).isFile()) {
      throw new Error(`${options.mode} source-map evidence is missing: ${mapPath}`);
    }
    const bytes = readFileSync(absoluteMap);
    const archivePath = `extension/${mapPath}`;
    const metadata = archive.entries.find(entry => entry.path === archivePath && !entry.directory);
    const packagedBytes = archive.capturedEntries[archivePath];
    const packaged = options.mode === "development";
    if (packaged && (!metadata || !packagedBytes || sha256(packagedBytes) !== sha256(bytes))) {
      throw new Error(`Development VSIX source map differs from the built map: ${mapPath}`);
    }
    if (!packaged && (metadata || packagedBytes)) {
      throw new Error(`Production VSIX unexpectedly contains a source map: ${mapPath}`);
    }
    return Object.freeze({
      path: mapPath,
      rawBytes: bytes.length,
      sha256: sha256(bytes),
      packaged,
      vsixCompressedBytes: metadata?.compressedBytes ?? 0,
      installedBytes: metadata?.installedBytes ?? 0
    });
  }).sort((left, right) => compareNames(left.path, right.path));

  return Object.freeze({
    mode: options.mode,
    commit: options.commit,
    toolchainFingerprint: options.toolchainFingerprint,
    runtimeVerification: options.runtimeVerification,
    artifact: Object.freeze({
      fileName: path.relative(options.outputDirectory, options.artifactFile).replaceAll("\\", "/"),
      sha256: archive.sha256,
      archiveBytes: archive.archiveBytes,
      compressedEntriesBytes: archive.compressedEntriesBytes,
      installedBytes: archive.installedBytes,
      fileCount: archive.fileCount
    }),
    stage: Object.freeze({
      contentHash: stage.contentHash,
      manifestSha256: stage.manifestSha256,
      paths: Object.freeze(stage.paths),
      files: Object.freeze(stage.files),
      vscodeIgnore: stage.vscodeIgnore
    }),
    manifest: Object.freeze({
      semanticHash: semanticJsonHash(manifestValue),
      value: manifestValue
    }),
    runtimeEntries: Object.freeze(runtimeEntries),
    sourceMaps: Object.freeze({
      files: Object.freeze(sourceMapFiles)
    }),
    jsonAssets: Object.freeze({ files: Object.freeze(jsonAssets) }),
    vsceMetadata: Object.freeze({
      files: Object.freeze(archive.entries
        .filter(entry => !entry.directory && !entry.path.startsWith("extension/"))
        .map(entry => Object.freeze({
          path: entry.path,
          vsixCompressedBytes: entry.compressedBytes,
          installedBytes: entry.installedBytes
        }))
        .sort((left, right) => compareNames(left.path, right.path)))
    }),
    archivePaths: Object.freeze(archive.entries.map(entry => entry.path).sort(compareNames))
  });
}

function readAndVerifyStage(stageRoot, manifestFile) {
  const manifestBytes = readFileSync(manifestFile);
  const manifest = parseJson(manifestBytes, "main VSIX stage contents manifest");
  const paths = manifest.files.map(file => file.path);
  if (!isSortedUnique(paths)) {
    throw new Error("Main VSIX stage contents paths are not sorted and unique.");
  }
  const contentHash = createHash("sha256");
  const jsonAssets = [];
  let vscodeIgnore;
  for (const file of manifest.files) {
    const absoluteFile = path.join(stageRoot, ...file.path.split("/"));
    const bytes = readFileSync(absoluteFile);
    const fileHash = sha256(bytes);
    if (bytes.length !== file.bytes || fileHash !== file.sha256) {
      throw new Error(`Main VSIX stage contents manifest mismatch: ${file.path}`);
    }
    contentHash.update(JSON.stringify([file.path, file.bytes, file.sha256]));
    contentHash.update("\n");
    if (file.path === ".vscodeignore") {
      vscodeIgnore = Object.freeze({
        bytes: bytes.length,
        sha256: fileHash,
        lines: Object.freeze(readVscodeIgnoreLines(bytes))
      });
    }
    if (file.path.endsWith(".json") && file.path !== "package.json") {
      const value = parseJson(bytes, `stage JSON ${file.path}`);
      const compactBytes = Buffer.from(JSON.stringify(value));
      jsonAssets.push(Object.freeze({
        path: file.path,
        bytes: bytes.length,
        semanticHash: semanticJsonHash(value),
        contentSha256: fileHash,
        compactSha256: sha256(compactBytes),
        compactBytes: compactBytes.length
      }));
    }
  }
  if (contentHash.digest("hex") !== manifest.contentHash) {
    throw new Error("Main VSIX stage aggregate content hash is invalid.");
  }
  if (!vscodeIgnore) {
    throw new Error("Main VSIX stage is missing its generated .vscodeignore policy.");
  }
  return Object.freeze({
    contentHash: manifest.contentHash,
    manifestSha256: sha256(manifestBytes),
    paths,
    files: manifest.files.map(file => Object.freeze({ ...file })),
    vscodeIgnore,
    jsonAssets: jsonAssets.sort((left, right) => compareNames(left.path, right.path))
  });
}

function readVscodeIgnoreLines(bytes) {
  const text = bytes.toString("utf8");
  if (text.includes("\0") || !text.endsWith("\n")) {
    throw new Error("Generated .vscodeignore must be UTF-8 text with a trailing newline.");
  }
  const lines = text.slice(0, -1).split(/\r?\n/);
  if (lines.some(line => line.length === 0)) {
    throw new Error("Generated .vscodeignore must not contain empty rules.");
  }
  return lines;
}

function verifyStageIsPackaged(stage, archive) {
  const archivePaths = new Set(archive.entries.filter(entry => !entry.directory).map(entry => entry.path));
  const expectedExtensionPaths = new Set(
    stage.paths.filter(stagePath => stagePath !== ".vscodeignore")
      .map(stagePath => `extension/${stagePath}`)
  );
  for (const stagePath of stage.paths) {
    if (stagePath === ".vscodeignore") {
      continue;
    }
    if (!archivePaths.has(`extension/${stagePath}`)) {
      throw new Error(`Official VSCE package omitted staged runtime file: ${stagePath}`);
    }
  }
  for (const archivePath of archivePaths) {
    if (archivePath.startsWith("extension/") && !expectedExtensionPaths.has(archivePath)) {
      throw new Error(`Official VSCE package added a file outside the verified stage: ${archivePath}`);
    }
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}.`, { cause: error });
  }
}

function isSortedUnique(values) {
  return values.every((value, index) => typeof value === "string"
    && (index === 0 || values[index - 1] < value));
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
