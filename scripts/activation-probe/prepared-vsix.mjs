import { sha256File } from "../lib/hash.mjs";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readVsixArchiveMetrics } from "../vsix-archive-metrics.mjs";

const require = createRequire(import.meta.url);
// yauzl is part of the locked VSCE toolchain and is also used by the VSIX metrics reader.
const yauzl = require("yauzl");

export const PREPARED_VSIX_CACHE_SCHEMA_VERSION = 2;
export const PREPARED_VSIX_TREE_ALGORITHM = "sha256-path-content-tree-v1";
export const PREPARED_VSIX_CACHE_RELATIVE_PATH = Object.freeze([
  "dist",
  "measurements",
  ".activation-vsix-cache",
  "v2"
]);

const MARKER_FILE_NAME = "prepared-vsix.json";
const REQUIRED_EXTENSION_FILES = Object.freeze([
  "package.json",
  "bundle/extension.js"
]);
const ARTIFACT_DIRECTORY_NAME = /^[a-f0-9]{64}$/;
const GENERATION_DIRECTORY_NAME = /^[a-f0-9]{64}\.g\d{8}$/;
const TEMPORARY_DIRECTORY_NAME = /^\.tmp-[a-f0-9]+$/;
const MAXIMUM_GENERATIONS = 10_000;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

export function resolvePreparedVsixCacheRoot(repositoryRoot = process.cwd()) {
  return path.join(
    path.resolve(requiredString(repositoryRoot, "repositoryRoot")),
    ...PREPARED_VSIX_CACHE_RELATIVE_PATH
  );
}

export async function prepareVsixExtension(options) {
  if (!options || typeof options !== "object") {
    throw new Error("Prepared VSIX options must be an object.");
  }
  const artifactPath = path.resolve(requiredString(options.artifactPath, "artifactPath"));
  const repositoryRoot = resolveRepositoryRoot(options.repositoryRoot ?? process.cwd());

  // Cache reuse remains bound to the current archive: derive the complete source
  // tree before looking at any marker or extracted generation.
  const metrics = await readVsixArchiveMetrics(artifactPath);
  const artifact = Object.freeze({ sha256: metrics.sha256, bytes: metrics.archiveBytes });
  const extensionTree = await deriveArchiveExtensionTree(artifactPath, metrics);
  assertArtifactIdentity(
    await readArtifactIdentity(artifactPath),
    artifact,
    "VSIX changed while its extension tree was read"
  );

  const cacheRoot = ensureCacheRoot(repositoryRoot);
  const artifactRoot = ensureArtifactRoot(cacheRoot, artifact.sha256);
  const cached = await findFirstValidGeneration(artifactRoot, artifact, extensionTree);
  if (cached) {
    return preparedResult("reused", artifactRoot, cached);
  }

  const rebuilding = listPublishedGenerationNames(artifactRoot).length > 0;
  const temporaryRoot = createTemporaryRoot(artifactRoot);
  try {
    const temporaryExtensionRoot = path.join(temporaryRoot, "extension");
    mkdirSync(temporaryExtensionRoot);
    const extractedArchiveTree = await deriveArchiveExtensionTree(
      artifactPath,
      metrics,
      temporaryExtensionRoot
    );
    assertSameTree(
      extensionTree,
      extractedArchiveTree,
      "VSIX extension tree changed between validation and extraction"
    );
    const extractedTree = await hashPreparedExtensionTree(temporaryExtensionRoot);
    assertSameTree(
      extensionTree,
      extractedTree,
      "Extracted VSIX extension tree does not match its archive contents"
    );
    assertInstalledExtension(temporaryExtensionRoot);
    assertArtifactIdentity(
      await readArtifactIdentity(artifactPath),
      artifact,
      "VSIX changed while its extension tree was extracted"
    );
    const marker = createMarker(artifact, extensionTree, extractedTree);
    writeFileSync(
      path.join(temporaryRoot, MARKER_FILE_NAME),
      `${JSON.stringify(marker, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );

    const publication = await publishImmutableGeneration(
      temporaryRoot,
      artifactRoot,
      artifact,
      extensionTree
    );
    const canonical = await findFirstValidGeneration(artifactRoot, artifact, extensionTree);
    if (!canonical) {
      throw new Error("Prepared VSIX generation failed its post-publication integrity check.");
    }
    return preparedResult(
      publication.published ? (rebuilding ? "rebuilt" : "created") : "reused",
      artifactRoot,
      canonical
    );
  } catch (error) {
    if (pathEntryExists(temporaryRoot)) {
      removeUnpublishedTemporaryRoot(temporaryRoot, artifactRoot);
    }
    throw error;
  }
}

export async function hashPreparedExtensionTree(extensionRoot) {
  const absoluteRoot = path.resolve(requiredString(extensionRoot, "extensionRoot"));
  const rootStat = lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Prepared extension root must be a real directory: ${absoluteRoot}`);
  }
  const records = [];
  const foldedPaths = new Set();

  async function visit(directory, relativeDirectory) {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absoluteEntry = path.join(directory, entry.name);
      const relativeEntry = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      assertPortableRelativePath(relativeEntry);
      const foldedPath = relativeEntry.toLowerCase();
      if (foldedPaths.has(foldedPath)) {
        throw new Error(`Prepared extension tree contains a case-colliding path: ${relativeEntry}`);
      }
      foldedPaths.add(foldedPath);
      const entryStat = lstatSync(absoluteEntry);
      if (entryStat.isSymbolicLink()) {
        throw new Error(`Prepared extension tree contains a symbolic link: ${relativeEntry}`);
      }
      if (entryStat.isDirectory()) {
        records.push({ kind: "directory", path: relativeEntry });
        await visit(absoluteEntry, relativeEntry);
        continue;
      }
      if (!entryStat.isFile()) {
        throw new Error(`Prepared extension tree contains a non-file entry: ${relativeEntry}`);
      }
      const file = await sha256File(absoluteEntry);
      if (file.bytes !== entryStat.size) {
        throw new Error(`Prepared extension file changed while it was hashed: ${relativeEntry}`);
      }
      records.push({ kind: "file", path: relativeEntry, bytes: file.bytes, sha256: file.sha256 });
    }
  }

  await visit(absoluteRoot, "");
  return finalizeTreeIdentity(records);
}

export function normalizeVsixArchivePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("VSIX entry paths must be non-empty strings without NUL bytes.");
  }
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Unsafe VSIX entry path: ${value}`);
  }
  const directory = value.endsWith("/");
  const rawPath = directory ? value.slice(0, -1) : value;
  const normalized = path.posix.normalize(rawPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`VSIX entry escapes the archive root: ${value}`);
  }
  if (normalized !== rawPath
    || normalized.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`VSIX entry path is not canonical: ${value}`);
  }
  assertPortableRelativePath(normalized);
  return directory ? `${normalized}/` : normalized;
}

function resolveRepositoryRoot(value) {
  const resolved = path.resolve(requiredString(value, "repositoryRoot"));
  const repositoryStat = lstatSync(resolved);
  if (!repositoryStat.isDirectory() || repositoryStat.isSymbolicLink()) {
    throw new Error(`repositoryRoot must be a real directory: ${resolved}`);
  }
  return realpathSync(resolved);
}

function ensureCacheRoot(repositoryRoot) {
  let current = repositoryRoot;
  for (const segment of PREPARED_VSIX_CACHE_RELATIVE_PATH) {
    const next = path.join(current, segment);
    mkdirForConcurrentCreators(next);
    const entryStat = lstatSync(next);
    if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
      throw new Error(`Prepared VSIX cache path must contain only real directories: ${next}`);
    }
    const realNext = realpathSync(next);
    assertPathWithin(repositoryRoot, realNext, "Prepared VSIX cache path escapes repositoryRoot");
    current = realNext;
  }
  return current;
}

function ensureArtifactRoot(cacheRoot, artifactSha256) {
  if (!ARTIFACT_DIRECTORY_NAME.test(artifactSha256)) {
    throw new Error("Prepared VSIX artifact cache key must be a lowercase SHA-256 digest.");
  }
  const artifactRoot = directChild(cacheRoot, artifactSha256, ARTIFACT_DIRECTORY_NAME, "artifact");
  mkdirForConcurrentCreators(artifactRoot);
  const entryStat = lstatSync(artifactRoot);
  if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
    throw new Error(`Prepared VSIX artifact cache root must be a real directory: ${artifactRoot}`);
  }
  assertPathWithin(cacheRoot, realpathSync(artifactRoot), "Prepared VSIX artifact cache escapes cache root");
  return artifactRoot;
}

function mkdirForConcurrentCreators(directory) {
  try {
    mkdirSync(directory);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
}

async function findFirstValidGeneration(artifactRoot, artifact, extensionTree) {
  const names = listPublishedGenerationNames(artifactRoot)
    .filter(name => name.startsWith(`${extensionTree.sha256}.g`));
  for (const name of names) {
    const generationRoot = directChild(
      artifactRoot,
      name,
      GENERATION_DIRECTORY_NAME,
      "generation"
    );
    const cached = await inspectPreparedGeneration(
      generationRoot,
      artifact,
      extensionTree
    );
    if (cached) {
      return { ...cached, generationRoot };
    }
  }
  return undefined;
}

function listPublishedGenerationNames(artifactRoot) {
  return readdirSync(artifactRoot, { withFileTypes: true })
    .filter(entry => GENERATION_DIRECTORY_NAME.test(entry.name))
    .map(entry => entry.name)
    .sort(compareText);
}

async function inspectPreparedGeneration(generationRoot, artifact, extensionTree) {
  try {
    const generationStat = lstatSync(generationRoot);
    if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) {
      return undefined;
    }
    const markerPath = path.join(generationRoot, MARKER_FILE_NAME);
    const markerStat = lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 64 * 1024) {
      return undefined;
    }
    const marker = validateMarker(JSON.parse(readFileSync(markerPath, "utf8")));
    if (!sameArtifact(marker.artifact, artifact)) {
      return undefined;
    }
    assertSameTree(marker.extensionTree, extensionTree, "Prepared VSIX marker does not match source archive");
    assertSameTree(marker.extensionTree, marker.extractedTree, "Prepared VSIX marker tree identities disagree");
    const extensionRoot = path.join(generationRoot, "extension");
    const extractedTree = await hashPreparedExtensionTree(extensionRoot);
    assertSameTree(extensionTree, extractedTree, "Prepared VSIX cache differs from source archive");
    assertSameTree(marker.extractedTree, extractedTree, "Prepared VSIX cache differs from marker");
    assertInstalledExtension(extensionRoot);
    return { marker, extensionTree, extractedTree };
  } catch {
    return undefined;
  }
}

function createTemporaryRoot(artifactRoot) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = `.tmp-${process.pid.toString(16)}${randomBytes(12).toString("hex")}`;
    const candidate = directChild(
      artifactRoot,
      name,
      TEMPORARY_DIRECTORY_NAME,
      "temporary generation"
    );
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error("Unable to allocate a unique prepared VSIX temporary generation.");
}

async function publishImmutableGeneration(temporaryRoot, artifactRoot, artifact, extensionTree) {
  for (let index = 0; index < MAXIMUM_GENERATIONS; index += 1) {
    const name = `${extensionTree.sha256}.g${String(index).padStart(8, "0")}`;
    const generationRoot = directChild(
      artifactRoot,
      name,
      GENERATION_DIRECTORY_NAME,
      "generation"
    );
    if (pathEntryExists(generationRoot)) {
      const existing = await inspectPreparedGeneration(generationRoot, artifact, extensionTree);
      if (existing) {
        removeUnpublishedTemporaryRoot(temporaryRoot, artifactRoot);
        return { published: false, generationRoot };
      }
      continue;
    }
    try {
      // The only publication mutation: rename a complete unpublished sibling to
      // a previously absent generation path. Published generations are never moved or removed.
      renameSync(temporaryRoot, generationRoot);
      return { published: true, generationRoot };
    } catch (error) {
      if (pathEntryExists(generationRoot)) {
        const winner = await inspectPreparedGeneration(generationRoot, artifact, extensionTree);
        if (winner) {
          removeUnpublishedTemporaryRoot(temporaryRoot, artifactRoot);
          return { published: false, generationRoot };
        }
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Prepared VSIX cache exceeds ${MAXIMUM_GENERATIONS} immutable generations.`);
}

async function deriveArchiveExtensionTree(artifactPath, metrics, extensionRoot) {
  const expectedEntries = new Map(metrics.entries.map(entry => [entry.path, entry]));
  const seenEntries = new Set();
  const records = [];
  const directories = new Set();
  const files = new Set();
  const zipFile = await openZip(artifactPath);
  let archiveError;
  const captureArchiveError = error => {
    archiveError = error;
  };
  zipFile.on("error", captureArchiveError);
  try {
    while (true) {
      const entry = await nextZipEntry(zipFile);
      if (!entry) {
        break;
      }
      const entryPath = normalizeVsixArchivePath(entry.fileName);
      const expected = expectedEntries.get(entryPath);
      if (!expected || seenEntries.has(entryPath)) {
        throw new Error(`VSIX archive entries changed while its extension tree was read: ${entryPath}`);
      }
      seenEntries.add(entryPath);
      assertZipEntryMetadata(entry, expected, entryPath);
      if (entryPath === "extension/" || !entryPath.startsWith("extension/")) {
        continue;
      }
      const relativePath = entryPath.slice("extension/".length);
      if (expected.directory) {
        const directoryPath = relativePath.slice(0, -1);
        addTreeDirectory(directoryPath, directories, files, records);
        if (extensionRoot) {
          mkdirSync(path.join(extensionRoot, ...directoryPath.split("/")), { recursive: true });
        }
        continue;
      }
      addTreeParents(relativePath, directories, files, records);
      if (directories.has(relativePath) || files.has(relativePath)) {
        throw new Error(`VSIX extension tree contains a file/directory collision: ${relativePath}`);
      }
      files.add(relativePath);
      let destination;
      if (extensionRoot) {
        destination = path.join(extensionRoot, ...relativePath.split("/"));
        assertPathWithin(extensionRoot, destination, "VSIX entry escapes prepared extension root");
        mkdirSync(path.dirname(destination), { recursive: true });
      }
      const fileIdentity = await streamZipEntry(zipFile, entry, destination);
      if (fileIdentity.bytes !== expected.installedBytes) {
        throw new Error(`VSIX entry size changed while its extension tree was read: ${entryPath}`);
      }
      records.push({
        kind: "file",
        path: relativePath,
        bytes: fileIdentity.bytes,
        sha256: fileIdentity.sha256
      });
    }
    if (archiveError) {
      throw new Error("Invalid VSIX archive while its extension tree was read.", { cause: archiveError });
    }
  } finally {
    zipFile.removeListener("error", captureArchiveError);
    zipFile.close();
  }
  if (seenEntries.size !== expectedEntries.size) {
    throw new Error("VSIX archive entry set changed while its extension tree was read.");
  }
  for (const requiredFile of REQUIRED_EXTENSION_FILES) {
    if (!files.has(requiredFile)) {
      throw new Error(`VSIX does not contain required extension file: extension/${requiredFile}`);
    }
  }
  return finalizeTreeIdentity(records);
}

function addTreeParents(filePath, directories, files, records) {
  const segments = filePath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    addTreeDirectory(segments.slice(0, index).join("/"), directories, files, records);
  }
}

function addTreeDirectory(directoryPath, directories, files, records) {
  if (!directoryPath) {
    return;
  }
  const segments = directoryPath.split("/");
  for (let index = 1; index <= segments.length; index += 1) {
    const parent = segments.slice(0, index).join("/");
    if (files.has(parent)) {
      throw new Error(`VSIX extension tree contains a file/directory collision: ${parent}`);
    }
    if (!directories.has(parent)) {
      directories.add(parent);
      records.push({ kind: "directory", path: parent });
    }
  }
}

function openZip(fileName) {
  return new Promise((resolve, reject) => {
    yauzl.open(fileName, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true
    }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(new Error(`Unable to open VSIX for prepared extraction: ${fileName}`, { cause: error }));
        return;
      }
      resolve(zipFile);
    });
  });
}

function nextZipEntry(zipFile) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zipFile.removeListener("entry", onEntry);
      zipFile.removeListener("end", onEnd);
      zipFile.removeListener("error", onError);
    };
    const onEntry = entry => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const onError = error => {
      cleanup();
      reject(new Error("Invalid VSIX archive while its extension tree was read.", { cause: error }));
    };
    zipFile.once("entry", onEntry);
    zipFile.once("end", onEnd);
    zipFile.once("error", onError);
    zipFile.readEntry();
  });
}

async function streamZipEntry(zipFile, entry, destination) {
  const stream = await openZipEntryStream(zipFile, entry);
  const hash = createHash("sha256");
  let bytes = 0;
  if (destination) {
    const hashingStream = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(stream, hashingStream, createWriteStream(destination, { flags: "wx" }));
  } else {
    for await (const chunk of stream) {
      bytes += chunk.length;
      hash.update(chunk);
    }
  }
  return { bytes, sha256: hash.digest("hex") };
}

function openZipEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(new Error(`Unable to read VSIX entry: ${entry.fileName}`, { cause: error }));
        return;
      }
      resolve(stream);
    });
  });
}

function assertZipEntryMetadata(entry, expected, entryPath) {
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new Error(`Encrypted VSIX entries are not supported: ${entryPath}`);
  }
  const madeByPlatform = entry.versionMadeBy >>> 8;
  const unixFileType = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (madeByPlatform === 3 && unixFileType === 0o120000) {
    throw new Error(`Symbolic-link VSIX entries are not supported: ${entryPath}`);
  }
  if (entry.compressedSize !== expected.compressedBytes
    || entry.uncompressedSize !== expected.installedBytes
    || entry.compressionMethod !== expected.compressionMethod
    || (entry.crc32 >>> 0) !== expected.crc32) {
    throw new Error(`VSIX entry metadata changed while its extension tree was read: ${entryPath}`);
  }
}

function finalizeTreeIdentity(records) {
  const sorted = [...records].sort((left, right) => {
    const pathComparison = compareText(left.path, right.path);
    return pathComparison === 0 ? compareText(left.kind, right.kind) : pathComparison;
  });
  const hash = createHash("sha256");
  let files = 0;
  let directories = 0;
  let bytes = 0;
  for (const record of sorted) {
    const serialized = JSON.stringify(record);
    hash.update(String(Buffer.byteLength(serialized, "utf8")));
    hash.update(":");
    hash.update(serialized);
    hash.update("\n");
    if (record.kind === "file") {
      files += 1;
      bytes += record.bytes;
    } else {
      directories += 1;
    }
  }
  return Object.freeze({
    algorithm: PREPARED_VSIX_TREE_ALGORITHM,
    sha256: hash.digest("hex"),
    files,
    directories,
    bytes
  });
}

function createMarker(artifact, extensionTree, extractedTree) {
  return Object.freeze({
    schemaVersion: PREPARED_VSIX_CACHE_SCHEMA_VERSION,
    artifact: Object.freeze({ sha256: artifact.sha256, bytes: artifact.bytes }),
    extensionTree,
    extractedTree
  });
}

function validateMarker(value) {
  if (!value || typeof value !== "object"
    || value.schemaVersion !== PREPARED_VSIX_CACHE_SCHEMA_VERSION) {
    throw new Error("Prepared VSIX cache marker has an unsupported schema.");
  }
  validateArtifactIdentity(value.artifact);
  validateTreeIdentity(value.extensionTree);
  validateTreeIdentity(value.extractedTree);
  return value;
}

function validateArtifactIdentity(value) {
  if (!value || typeof value !== "object"
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
    throw new Error("Prepared VSIX marker has an invalid artifact identity.");
  }
}

function validateTreeIdentity(value) {
  if (!value || typeof value !== "object"
    || value.algorithm !== PREPARED_VSIX_TREE_ALGORITHM
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.files) || value.files < 0
    || !Number.isSafeInteger(value.directories) || value.directories < 0
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new Error("Prepared VSIX marker has an invalid tree identity.");
  }
}

function assertSameTree(left, right, label) {
  if (left.algorithm !== right.algorithm
    || left.sha256 !== right.sha256
    || left.files !== right.files
    || left.directories !== right.directories
    || left.bytes !== right.bytes) {
    throw new Error(`${label}.`);
  }
}

function assertInstalledExtension(extensionRoot) {
  for (const relativePath of REQUIRED_EXTENSION_FILES) {
    const fileName = path.join(extensionRoot, ...relativePath.split("/"));
    if (!existsSync(fileName)) {
      throw new Error(`Prepared VSIX is missing required extension file: ${relativePath}`);
    }
    const fileStat = lstatSync(fileName);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`Prepared VSIX required path is not a regular file: ${relativePath}`);
    }
  }
}

function removeUnpublishedTemporaryRoot(candidate, artifactRoot) {
  const expected = directChild(
    artifactRoot,
    path.basename(candidate),
    TEMPORARY_DIRECTORY_NAME,
    "temporary generation"
  );
  if (path.relative(expected, path.resolve(candidate)) !== "") {
    throw new Error(`Refusing to remove a path outside the prepared VSIX temporary area: ${candidate}`);
  }
  removeTreeWithoutFollowingLinks(expected);
}

function removeTreeWithoutFollowingLinks(candidate) {
  if (!pathEntryExists(candidate)) {
    return;
  }
  const entryStat = lstatSync(candidate);
  if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
    unlinkSync(candidate);
    return;
  }
  for (const entry of readdirSync(candidate)) {
    removeTreeWithoutFollowingLinks(path.join(candidate, entry));
  }
  rmdirSync(candidate);
}

function directChild(parent, name, pattern, label) {
  if (!pattern.test(name)) {
    throw new Error(`Invalid prepared VSIX ${label} directory name: ${name}`);
  }
  const candidate = path.resolve(parent, name);
  const relative = path.relative(parent, candidate);
  if (!relative || path.isAbsolute(relative) || relative === ".."
    || relative.startsWith(`..${path.sep}`) || relative.includes(path.sep)) {
    throw new Error(`Prepared VSIX ${label} path is not a direct child: ${candidate}`);
  }
  return candidate;
}

function assertPortableRelativePath(value) {
  for (const segment of value.split("/")) {
    if (!segment || /[\u0000-\u001f<>:"|?*]/.test(segment)
      || segment.endsWith(".") || segment.endsWith(" ")
      || WINDOWS_RESERVED_NAME.test(segment)) {
      throw new Error(`VSIX entry path is not portable to Windows: ${value}`);
    }
  }
}

function assertPathWithin(parent, candidate, label) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === "" || (!path.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    return;
  }
  throw new Error(`${label}: ${candidate}`);
}

async function readArtifactIdentity(fileName) {
  const before = statSync(fileName);
  if (!before.isFile() || before.size <= 0) {
    throw new Error(`Prepared VSIX artifact must be a non-empty regular file: ${fileName}`);
  }
  const hashed = await sha256File(fileName);
  const after = statSync(fileName);
  if (!after.isFile() || hashed.bytes !== before.size || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`Prepared VSIX artifact changed while it was hashed: ${fileName}`);
  }
  return Object.freeze({ sha256: hashed.sha256, bytes: hashed.bytes });
}


function assertArtifactIdentity(actual, expected, label) {
  if (!sameArtifact(actual, expected)) {
    throw new Error(`${label}.`);
  }
}

function sameArtifact(left, right) {
  return left?.sha256 === right?.sha256 && left?.bytes === right?.bytes;
}

function preparedResult(status, artifactRoot, cached) {
  return Object.freeze({
    status,
    artifact: cached.marker.artifact,
    artifactRoot,
    cacheEntryRoot: cached.generationRoot,
    extensionRoot: path.join(cached.generationRoot, "extension"),
    markerPath: path.join(cached.generationRoot, MARKER_FILE_NAME),
    extensionTree: cached.extensionTree,
    extractedTree: cached.extractedTree
  });
}

function pathEntryExists(value) {
  try {
    lstatSync(value);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}
