import { createHash } from "node:crypto";
import {
  combinedVsixArtifactNames,
  combinedVsixRuntimeEntries,
  combinedVsixRuntimeSourceMaps
} from "./combined-vsix-layout.mjs";

export {
  combinedVsixArtifactNames,
  combinedVsixRuntimeEntries,
  combinedVsixRuntimeSourceMaps
} from "./combined-vsix-layout.mjs";

export const combinedVsixReportSchemaVersion = 1;

const combinedVsixVsceMetadataPaths = Object.freeze([
  "[Content_Types].xml",
  "extension.vsixmanifest"
].sort());

export function createCombinedVsixReport(input) {
  validateReportIdentity(input?.repository, input?.toolchain);
  const development = validateModeEvidence(input?.development, "development");
  const production = validateModeEvidence(input?.production, "production");
  const entryIds = Object.keys(combinedVsixRuntimeEntries);

  if (development.commit !== input.repository?.commit
    || production.commit !== input.repository?.commit) {
    throw new Error("Combined VSIX evidence was not captured from one Git commit.");
  }
  if (development.toolchainFingerprint !== input.toolchain?.fingerprint
    || production.toolchainFingerprint !== input.toolchain?.fingerprint) {
    throw new Error("Combined VSIX evidence was not captured with one toolchain.");
  }

  assertStagePathRelationship(development.stage.paths, production.stage.paths);
  assertStageIgnoreRelationship(
    development.stage.vscodeIgnore,
    production.stage.vscodeIgnore
  );
  const stageContentAttribution = compareStageContents(development, production);
  assertDeepEqual(
    development.manifest.value,
    production.manifest.value,
    "Development and production publish manifests differ."
  );
  assertSingleVsixManifest(development.manifest.value);
  assertSingleVsixManifest(production.manifest.value);
  assertSafeArchiveContents(development.archivePaths, "development");
  assertSafeArchiveContents(production.archivePaths, "production");

  const entries = {};
  for (const id of entryIds) {
    const developmentEntry = development.runtimeEntries[id];
    const productionEntry = production.runtimeEntries[id];
    if (developmentEntry.path !== combinedVsixRuntimeEntries[id]
      || productionEntry.path !== combinedVsixRuntimeEntries[id]) {
      throw new Error(`Unexpected runtime path for ${id}.`);
    }
    assertInstalledMatchesRaw(id, "development", developmentEntry);
    assertInstalledMatchesRaw(id, "production", productionEntry);
    const delta = Object.freeze({
      rawBytes: developmentEntry.rawBytes - productionEntry.rawBytes,
      vsixCompressedBytes:
        developmentEntry.vsixCompressedBytes - productionEntry.vsixCompressedBytes,
      installedBytes: developmentEntry.installedBytes - productionEntry.installedBytes
    });
    for (const [metric, value] of Object.entries(delta)) {
      if (value <= 0) {
        throw new Error(
          `Production ${id} ${metric} must be smaller than the same-commit development entry.`
        );
      }
    }
    entries[id] = Object.freeze({
      path: combinedVsixRuntimeEntries[id],
      development: selectEntryMetrics(developmentEntry),
      production: selectEntryMetrics(productionEntry),
      delta
    });
  }

  const jsonWhitespace = compareJsonAssets(development.jsonAssets, production.jsonAssets);
  if (jsonWhitespace.savingsBytes <= 0) {
    throw new Error("Production JSON staging did not produce a provable whitespace saving.");
  }
  const totals = compareTotals(development.artifact, production.artifact);
  if (totals.delta.archiveBytes <= 0 || totals.delta.installedBytes <= 0) {
    throw new Error("Production VSIX must be smaller in both archive and installed bytes.");
  }
  if (totals.delta.fileCount !== combinedVsixRuntimeSourceMaps.length) {
    throw new Error("Development VSIX must contain exactly five additional source-map files.");
  }

  const sourceMaps = compareSourceMaps(development, production);
  const vsceMetadata = compareVsceMetadata(development.vsceMetadata, production.vsceMetadata);
  const sizeAttribution = reconcileSizeAttribution(
    entries,
    jsonWhitespace,
    sourceMaps,
    vsceMetadata,
    totals
  );

  const runtimeCapabilityHash = semanticJsonHash({
    manifest: development.manifest.value,
    stagePaths: production.stage.paths,
    runtimeEntries: combinedVsixRuntimeEntries
  });
  const budgetCandidate = Object.freeze({
    status: "measured-exact-values-require-reviewed-headroom-before-freezing",
    mainVsix: Object.freeze({
      archiveBytes: production.artifact.archiveBytes,
      compressedEntriesBytes: production.artifact.compressedEntriesBytes,
      installedBytes: production.artifact.installedBytes,
      fileCount: production.artifact.fileCount,
      runtimeEntryCompressedBytes: Object.freeze(Object.fromEntries(
        entryIds.map(id => [id, production.runtimeEntries[id].vsixCompressedBytes])
      ))
    })
  });

  return Object.freeze({
    schemaVersion: combinedVsixReportSchemaVersion,
    repository: input.repository,
    toolchain: input.toolchain,
    artifacts: Object.freeze({
      development: summarizeModeEvidence(development),
      production: summarizeModeEvidence(production)
    }),
    comparison: Object.freeze({
      checks: Object.freeze({
        sameCommit: true,
        sameToolchain: true,
        entryNamesEquivalent: true,
        manifestEquivalent: true,
        runtimeCapabilitiesEquivalent: true,
        runtimeSmokeEquivalent: true,
        stageRuntimePathsEquivalent: true,
        stagePathsMatchComparisonPolicy: true,
        developmentContainsExactSourceMaps: true,
        nonOptimizedStageFilesEquivalent: true,
        noNestedOrCompanionVsixPath: true,
        productionSourceMapsExcluded: true,
        sizeAttributionReconciled: true,
        productionEntriesAllSmaller: true
      }),
      runtimeCapabilityHash,
      entries: Object.freeze(entries),
      totals,
      sizeAttribution,
      stageContentAttribution,
      sourceMaps: Object.freeze(sourceMaps),
      vsceMetadata,
      jsonWhitespace
    }),
    budgetCandidate
  });
}

export function semanticJsonHash(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function validateReportIdentity(repository, toolchain) {
  if (!repository || repository.clean !== true
    || !/^[0-9a-f]{40,64}$/.test(repository.commit ?? "")
    || !/^[0-9a-f]{40,64}$/.test(repository.tree ?? "")
    || !/^\d+$/.test(repository.commitTimestamp ?? "")) {
    throw new Error("Combined VSIX report requires a clean, immutable Git commit/tree identity.");
  }
  if (!toolchain || typeof toolchain.fingerprint !== "string") {
    throw new Error("Combined VSIX report requires a toolchain fingerprint.");
  }
  const { fingerprint, ...identity } = toolchain;
  if (fingerprint !== semanticJsonHash(identity)) {
    throw new Error("Combined VSIX toolchain fingerprint does not match its recorded identity.");
  }
}

function validateModeEvidence(value, expectedMode) {
  if (!value || value.mode !== expectedMode) {
    throw new Error(`Missing ${expectedMode} VSIX measurement evidence.`);
  }
  const expectedRuntimeArguments = expectedMode === "development"
    ? ["--comparison-development"]
    : [];
  if (value.runtimeVerification?.script !== "scripts/verify-main-vsix.mjs"
    || value.runtimeVerification?.passed !== true
    || stableJson(value.runtimeVerification?.arguments) !== stableJson(expectedRuntimeArguments)) {
    throw new Error(`${expectedMode} VSIX did not pass the canonical packaged runtime smoke.`);
  }
  if (value.artifact?.fileName !== combinedVsixArtifactNames[expectedMode]) {
    throw new Error(`Unexpected ${expectedMode} comparison VSIX file name.`);
  }
  const expectedEntries = Object.keys(combinedVsixRuntimeEntries);
  assertDeepEqual(
    Object.keys(value.runtimeEntries ?? {}).sort(),
    [...expectedEntries].sort(),
    `${expectedMode} runtime entry names differ from the canonical five-entry layout.`
  );
  if (value.manifest.semanticHash !== semanticJsonHash(value.manifest.value)) {
    throw new Error(`${expectedMode} manifest semantic hash does not match its value.`);
  }
  if (!Array.isArray(value.stage.paths) || !isSortedUnique(value.stage.paths)) {
    throw new Error(`${expectedMode} stage paths must be a sorted unique list.`);
  }
  if (!Array.isArray(value.stage.files)
    || !isSortedUnique(value.stage.files.map(file => file.path))) {
    throw new Error(`${expectedMode} stage file evidence must be a sorted unique list.`);
  }
  assertDeepEqual(
    value.stage.files.map(file => file.path),
    value.stage.paths,
    `${expectedMode} stage file evidence does not match its path list.`
  );
  const stageFiles = new Map(value.stage.files.map(file => [file.path, file]));
  const ignoreStageFile = stageFiles.get(".vscodeignore");
  if (!ignoreStageFile || value.stage.vscodeIgnore?.bytes !== ignoreStageFile.bytes
    || value.stage.vscodeIgnore?.sha256 !== ignoreStageFile.sha256
    || !Array.isArray(value.stage.vscodeIgnore?.lines)) {
    throw new Error(`${expectedMode} .vscodeignore evidence does not match the stage.`);
  }
  assertDeepEqual(
    value.jsonAssets.files.map(file => file.path),
    value.stage.paths.filter(entryPath => entryPath.endsWith(".json") && entryPath !== "package.json"),
    `${expectedMode} JSON asset evidence is incomplete.`
  );
  for (const [id, runtimePath] of Object.entries(combinedVsixRuntimeEntries)) {
    const stageFile = stageFiles.get(runtimePath);
    const runtimeEntry = value.runtimeEntries[id];
    if (!stageFile || stageFile.bytes !== runtimeEntry.rawBytes
      || stageFile.sha256 !== runtimeEntry.sha256) {
      throw new Error(`${expectedMode} stage/runtime evidence mismatch for ${runtimePath}.`);
    }
  }
  for (const jsonAsset of value.jsonAssets.files) {
    const stageFile = stageFiles.get(jsonAsset.path);
    if (!stageFile || stageFile.bytes !== jsonAsset.bytes
      || stageFile.sha256 !== jsonAsset.contentSha256) {
      throw new Error(`${expectedMode} stage/JSON evidence mismatch for ${jsonAsset.path}.`);
    }
  }
  assertDeepEqual(
    value.sourceMaps.files.map(file => file.path),
    combinedVsixRuntimeSourceMaps,
    `${expectedMode} source-map evidence is incomplete.`
  );
  for (const sourceMap of value.sourceMaps.files) {
    const stageFile = stageFiles.get(sourceMap.path);
    if (!Number.isSafeInteger(sourceMap.rawBytes) || sourceMap.rawBytes <= 0
      || typeof sourceMap.sha256 !== "string" || sourceMap.sha256.length === 0) {
      throw new Error(`${expectedMode} source-map build evidence is invalid: ${sourceMap.path}`);
    }
    if (expectedMode === "development") {
      if (!stageFile || stageFile.bytes !== sourceMap.rawBytes
        || stageFile.sha256 !== sourceMap.sha256 || sourceMap.packaged !== true
        || sourceMap.installedBytes !== sourceMap.rawBytes
        || sourceMap.vsixCompressedBytes <= 0) {
        throw new Error(`Development source-map evidence is invalid: ${sourceMap.path}`);
      }
    } else if (stageFile || sourceMap.packaged !== false
      || sourceMap.installedBytes !== 0 || sourceMap.vsixCompressedBytes !== 0) {
      throw new Error(`Production source-map exclusion evidence is invalid: ${sourceMap.path}`);
    }
  }
  return value;
}

function assertStagePathRelationship(developmentPaths, productionPaths) {
  assertDeepEqual(
    developmentPaths,
    [...productionPaths, ...combinedVsixRuntimeSourceMaps].sort(),
    "Development stage must equal production plus the exact five external source maps."
  );
}

function assertStageIgnoreRelationship(development, production) {
  assertDeepEqual(
    production.lines,
    ["**/*.map", ...development.lines],
    "Production .vscodeignore must add only the external source-map exclusion rule."
  );
}

function compareStageContents(development, production) {
  const developmentFiles = new Map(development.stage.files.map(file => [file.path, file]));
  const productionFiles = new Map(production.stage.files.map(file => [file.path, file]));
  const runtimePaths = new Set(Object.values(combinedVsixRuntimeEntries));
  const jsonPaths = new Set(development.jsonAssets.files.map(file => file.path));
  let unchangedFiles = 0;
  for (const entryPath of production.stage.paths) {
    const before = developmentFiles.get(entryPath);
    const after = productionFiles.get(entryPath);
    if (runtimePaths.has(entryPath) || jsonPaths.has(entryPath)
      || entryPath === ".vscodeignore") {
      continue;
    }
    if (before.bytes !== after.bytes || before.sha256 !== after.sha256) {
      throw new Error(`Non-optimized VSIX stage file changed between modes: ${entryPath}`);
    }
    unchangedFiles += 1;
  }
  if (development.stage.contentHash === production.stage.contentHash) {
    throw new Error("Development and production stage content hashes unexpectedly match.");
  }
  return Object.freeze({
    runtimeEntryFiles: runtimePaths.size,
    jsonWhitespaceFiles: jsonPaths.size,
    developmentSourceMapFiles: combinedVsixRuntimeSourceMaps.length,
    sourceMapPolicyFiles: 1,
    unchangedFiles
  });
}

function assertSingleVsixManifest(manifest) {
  if (manifest.main !== "./bundle/extension.js" && manifest.main !== "bundle/extension.js") {
    throw new Error("Combined VSIX manifest must have one canonical root extension entry.");
  }
  if (manifest.extensionPack !== undefined || manifest.extensionDependencies !== undefined) {
    throw new Error("Combined VSIX manifest must not reference a second extension or VSIX path.");
  }
  if (!Array.isArray(manifest.extensionKind) || !manifest.extensionKind.includes("workspace")) {
    throw new Error("Combined VSIX manifest must retain workspace extension capability.");
  }
}

function assertSafeArchiveContents(paths, mode) {
  if (!Array.isArray(paths) || !isSortedUnique(paths)) {
    throw new Error(`${mode} VSIX archive paths must be a sorted unique list.`);
  }
  const actualSourceMaps = [];
  for (const entryPath of paths) {
    const lower = entryPath.toLowerCase();
    if (lower.endsWith(".map")) {
      actualSourceMaps.push(entryPath);
    }
    if (lower.endsWith(".vsix") || lower.includes("extensions/vscode-rsgl")) {
      throw new Error(`${mode} VSIX contains a forbidden second VSIX/companion path: ${entryPath}`);
    }
  }
  const expectedSourceMaps = mode === "development"
    ? combinedVsixRuntimeSourceMaps.map(mapPath => `extension/${mapPath}`).sort()
    : [];
  assertDeepEqual(
    actualSourceMaps.sort(),
    expectedSourceMaps,
    `${mode} VSIX source-map paths do not match the comparison policy.`
  );
  for (const runtimePath of Object.values(combinedVsixRuntimeEntries)) {
    if (!paths.includes(`extension/${runtimePath}`)) {
      throw new Error(`${mode} VSIX is missing runtime entry: ${runtimePath}`);
    }
  }
}

function compareSourceMaps(development, production) {
  const developmentByPath = new Map(development.sourceMaps.files.map(file => [file.path, file]));
  const productionByPath = new Map(production.sourceMaps.files.map(file => [file.path, file]));
  const files = combinedVsixRuntimeSourceMaps.map(mapPath => {
    const before = developmentByPath.get(mapPath);
    const after = productionByPath.get(mapPath);
    return Object.freeze({
      path: mapPath,
      development: Object.freeze({ ...before }),
      production: Object.freeze({ ...after }),
      savings: Object.freeze({
        rawBytes: before.rawBytes,
        vsixCompressedBytes: before.vsixCompressedBytes,
        installedBytes: before.installedBytes
      })
    });
  });
  const developmentRawBytes = sum(files, file => file.development.rawBytes);
  const productionGeneratedRawBytes = sum(files, file => file.production.rawBytes);
  const vsixCompressedSavings = sum(files, file => file.savings.vsixCompressedBytes);
  const installedSavings = sum(files, file => file.savings.installedBytes);
  if (vsixCompressedSavings <= 0 || installedSavings !== developmentRawBytes) {
    throw new Error("Source-map exclusion savings are incomplete or internally inconsistent.");
  }
  return Object.freeze({
    policy: "development packages five external maps; production generates then excludes them",
    development: Object.freeze({
      fileCount: files.length,
      rawBytes: developmentRawBytes,
      vsixCompressedBytes: vsixCompressedSavings,
      installedBytes: installedSavings
    }),
    production: Object.freeze({
      fileCount: 0,
      generatedRawBytes: productionGeneratedRawBytes,
      vsixCompressedBytes: 0,
      installedBytes: 0
    }),
    savings: Object.freeze({
      fileCount: files.length,
      rawBytes: developmentRawBytes,
      vsixCompressedBytes: vsixCompressedSavings,
      installedBytes: installedSavings
    }),
    files: Object.freeze(files)
  });
}

function compareVsceMetadata(development, production) {
  const developmentFiles = development?.files;
  const productionFiles = production?.files;
  if (!Array.isArray(developmentFiles) || !Array.isArray(productionFiles)
    || !isSortedUnique(developmentFiles.map(file => file.path))
    || !isSortedUnique(productionFiles.map(file => file.path))) {
    throw new Error("VSCE-generated archive metadata evidence must be sorted and unique.");
  }
  assertDeepEqual(
    developmentFiles.map(file => file.path),
    combinedVsixVsceMetadataPaths,
    "Development archive does not contain the exact official VSCE metadata files."
  );
  assertDeepEqual(
    developmentFiles.map(file => file.path),
    productionFiles.map(file => file.path),
    "Development and production VSCE-generated metadata paths differ."
  );
  const files = developmentFiles.map((before, index) => {
    const after = productionFiles[index];
    for (const evidence of [before, after]) {
      if (!Number.isSafeInteger(evidence.vsixCompressedBytes)
        || evidence.vsixCompressedBytes <= 0
        || !Number.isSafeInteger(evidence.installedBytes)
        || evidence.installedBytes <= 0) {
        throw new Error(`Invalid VSCE-generated metadata byte evidence: ${evidence.path}`);
      }
    }
    return Object.freeze({
      path: before.path,
      development: Object.freeze({
        vsixCompressedBytes: before.vsixCompressedBytes,
        installedBytes: before.installedBytes
      }),
      production: Object.freeze({
        vsixCompressedBytes: after.vsixCompressedBytes,
        installedBytes: after.installedBytes
      }),
      delta: Object.freeze({
        vsixCompressedBytes: before.vsixCompressedBytes - after.vsixCompressedBytes,
        installedBytes: before.installedBytes - after.installedBytes
      })
    });
  });
  return Object.freeze({
    explanation: "VSCE regenerates top-level ZIP metadata from each exact staged file set.",
    development: Object.freeze({
      fileCount: developmentFiles.length,
      vsixCompressedBytes: sum(developmentFiles, file => file.vsixCompressedBytes),
      installedBytes: sum(developmentFiles, file => file.installedBytes)
    }),
    production: Object.freeze({
      fileCount: productionFiles.length,
      vsixCompressedBytes: sum(productionFiles, file => file.vsixCompressedBytes),
      installedBytes: sum(productionFiles, file => file.installedBytes)
    }),
    delta: Object.freeze({
      fileCount: developmentFiles.length - productionFiles.length,
      vsixCompressedBytes: sum(files, file => file.delta.vsixCompressedBytes),
      installedBytes: sum(files, file => file.delta.installedBytes)
    }),
    files: Object.freeze(files)
  });
}

function reconcileSizeAttribution(entries, jsonWhitespace, sourceMaps, vsceMetadata, totals) {
  const entryValues = Object.values(entries);
  const minifyCompressedSavings = sum(entryValues, entry => entry.delta.vsixCompressedBytes);
  const minifyInstalledSavings = sum(entryValues, entry => entry.delta.installedBytes);
  const explainedCompressedSavings = minifyCompressedSavings
    + jsonWhitespace.vsixCompressedSavings
    + sourceMaps.savings.vsixCompressedBytes
    + vsceMetadata.delta.vsixCompressedBytes;
  const explainedInstalledSavings = minifyInstalledSavings
    + jsonWhitespace.installedSavings
    + sourceMaps.savings.installedBytes
    + vsceMetadata.delta.installedBytes;
  if (explainedCompressedSavings !== totals.delta.compressedEntriesBytes
    || explainedInstalledSavings !== totals.delta.installedBytes) {
    throw new Error(
      "VSIX size delta is not fully explained by minify, JSON whitespace, maps, and VSCE metadata."
    );
  }
  const zipStructuralOverheadBytes = totals.delta.archiveBytes - explainedCompressedSavings;
  if (zipStructuralOverheadBytes <= 0) {
    throw new Error("Development source maps did not produce positive ZIP structural overhead.");
  }
  return Object.freeze({
    minify: Object.freeze({
      vsixCompressedBytes: minifyCompressedSavings,
      installedBytes: minifyInstalledSavings
    }),
    jsonWhitespace: Object.freeze({
      vsixCompressedBytes: jsonWhitespace.vsixCompressedSavings,
      installedBytes: jsonWhitespace.installedSavings
    }),
    sourceMapExclusion: Object.freeze({ ...sourceMaps.savings }),
    vsceGeneratedMetadata: Object.freeze({ ...vsceMetadata.delta }),
    compressedEntriesBytes: explainedCompressedSavings,
    installedBytes: explainedInstalledSavings,
    archiveBytes: totals.delta.archiveBytes,
    zipStructuralOverheadBytes
  });
}

function compareJsonAssets(development, production) {
  const developmentByPath = new Map(development.files.map(file => [file.path, file]));
  const productionByPath = new Map(production.files.map(file => [file.path, file]));
  assertDeepEqual(
    [...developmentByPath.keys()].sort(),
    [...productionByPath.keys()].sort(),
    "Development and production JSON asset paths differ."
  );
  const files = [];
  let developmentBytes = 0;
  let productionBytes = 0;
  let developmentCompressedBytes = 0;
  let productionCompressedBytes = 0;
  for (const entryPath of [...developmentByPath.keys()].sort()) {
    const before = developmentByPath.get(entryPath);
    const after = productionByPath.get(entryPath);
    if (before.semanticHash !== after.semanticHash) {
      throw new Error(`JSON staging changed semantics: ${entryPath}`);
    }
    if (before.compactSha256 !== after.compactSha256
      || before.compactBytes !== after.compactBytes
      || after.contentSha256 !== after.compactSha256
      || after.bytes !== after.compactBytes) {
      throw new Error(`Production JSON is not the exact whitespace-free form: ${entryPath}`);
    }
    if (after.bytes > before.bytes) {
      throw new Error(`Production JSON is larger than its development form: ${entryPath}`);
    }
    if (before.installedBytes !== before.bytes || after.installedBytes !== after.bytes
      || before.vsixCompressedBytes <= 0 || after.vsixCompressedBytes <= 0) {
      throw new Error(`JSON VSIX byte evidence is invalid: ${entryPath}`);
    }
    developmentBytes += before.bytes;
    productionBytes += after.bytes;
    developmentCompressedBytes += before.vsixCompressedBytes;
    productionCompressedBytes += after.vsixCompressedBytes;
    files.push(Object.freeze({
      path: entryPath,
      semanticHash: before.semanticHash,
      compactSha256: before.compactSha256,
      developmentContentSha256: before.contentSha256,
      productionContentSha256: after.contentSha256,
      developmentBytes: before.bytes,
      productionBytes: after.bytes,
      developmentVsixCompressedBytes: before.vsixCompressedBytes,
      productionVsixCompressedBytes: after.vsixCompressedBytes,
      vsixCompressedSavings: before.vsixCompressedBytes - after.vsixCompressedBytes,
      compactBytes: before.compactBytes,
      savingsBytes: before.bytes - after.bytes
    }));
  }
  if (developmentCompressedBytes < productionCompressedBytes) {
    throw new Error("Production JSON compressed bytes exceed development JSON compressed bytes.");
  }
  return Object.freeze({
    proof: "equal parsed-JSON semantic hashes; byte delta is whitespace-only staging",
    developmentBytes,
    productionBytes,
    savingsBytes: developmentBytes - productionBytes,
    developmentVsixCompressedBytes: developmentCompressedBytes,
    productionVsixCompressedBytes: productionCompressedBytes,
    vsixCompressedSavings: developmentCompressedBytes - productionCompressedBytes,
    installedSavings: developmentBytes - productionBytes,
    files: Object.freeze(files)
  });
}

function compareTotals(development, production) {
  const metrics = ["archiveBytes", "compressedEntriesBytes", "installedBytes", "fileCount"];
  return Object.freeze({
    development: selectProperties(development, metrics),
    production: selectProperties(production, metrics),
    delta: Object.freeze(Object.fromEntries(
      metrics.map(metric => [metric, development[metric] - production[metric]])
    ))
  });
}

function summarizeModeEvidence(evidence) {
  return Object.freeze({
    mode: evidence.mode,
    artifact: Object.freeze({ ...evidence.artifact }),
    stage: Object.freeze({
      contentHash: evidence.stage.contentHash,
      manifestSha256: evidence.stage.manifestSha256,
      fileCount: evidence.stage.paths.length
    }),
    manifestSemanticHash: evidence.manifest.semanticHash,
    runtimeVerification: Object.freeze({ ...evidence.runtimeVerification }),
    runtimeEntries: Object.freeze(Object.fromEntries(
      Object.entries(evidence.runtimeEntries).map(([id, entry]) => [id, Object.freeze({ ...entry })])
    )),
    sourceMaps: Object.freeze({
      generatedRawBytes: sum(evidence.sourceMaps.files, file => file.rawBytes),
      packagedCompressedBytes: sum(evidence.sourceMaps.files, file => file.vsixCompressedBytes),
      packagedInstalledBytes: sum(evidence.sourceMaps.files, file => file.installedBytes)
    }),
    vsceMetadata: Object.freeze({
      fileCount: evidence.vsceMetadata.files.length,
      vsixCompressedBytes: sum(
        evidence.vsceMetadata.files,
        file => file.vsixCompressedBytes
      ),
      installedBytes: sum(evidence.vsceMetadata.files, file => file.installedBytes)
    }),
    jsonStagedBytes: evidence.jsonAssets.files.reduce((sum, file) => sum + file.bytes, 0)
  });
}

function assertInstalledMatchesRaw(id, mode, entry) {
  if (entry.installedBytes !== entry.rawBytes) {
    throw new Error(`${mode} ${id} raw and installed bytes differ.`);
  }
}

function selectEntryMetrics(entry) {
  return Object.freeze(selectProperties(entry, [
    "rawBytes",
    "vsixCompressedBytes",
    "installedBytes",
    "sha256"
  ]));
}

function selectProperties(value, names) {
  return Object.fromEntries(names.map(name => [name, value[name]]));
}

function sum(values, selector) {
  return values.reduce((total, value) => total + selector(value), 0);
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, sortJson(value[key])])
    );
  }
  return value;
}

function isSortedUnique(values) {
  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== "string") {
      return false;
    }
    if (index > 0 && values[index - 1] >= values[index]) {
      return false;
    }
  }
  return true;
}

function assertDeepEqual(actual, expected, message) {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(message);
  }
}
