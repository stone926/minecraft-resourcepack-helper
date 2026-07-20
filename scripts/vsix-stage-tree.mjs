import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

export const stageContentsSchemaVersion = 1;
export const forbiddenStageSuffixes = Object.freeze([".map"]);

let temporaryFileSequence = 0;

export function assembleVsixStageTree(options) {
  const stageRoot = path.resolve(requiredString(options?.stageRoot, "stageRoot"));
  const allowedStageParent = path.resolve(requiredString(
    options?.allowedStageParent ?? path.dirname(stageRoot),
    "allowedStageParent"
  ));
  const contentsManifestFile = path.resolve(requiredString(
    options?.contentsManifestFile,
    "contentsManifestFile"
  ));
  const sourceDateEpoch = validateSourceDateEpoch(options?.sourceDateEpoch);
  const timestamp = new Date(sourceDateEpoch * 1_000);

  assertStrictDescendant(allowedStageParent, stageRoot, "stageRoot");
  assertDescendant(allowedStageParent, contentsManifestFile, "contentsManifestFile");
  if (isPathAtOrBelow(stageRoot, contentsManifestFile)) {
    throw new Error("contentsManifestFile must be outside the VSIX stage tree.");
  }

  validateExistingStageRoot(stageRoot);
  mkdirSync(allowedStageParent, { recursive: true });
  mkdirSync(stageRoot, { recursive: true });

  const desiredFiles = normalizeDesiredFiles(options?.files);
  const desiredPaths = new Set(desiredFiles.map(file => file.path));
  const desiredDirectories = collectDesiredDirectories(desiredFiles);
  const removed = reconcileStageShape(stageRoot, desiredPaths, desiredDirectories);

  for (const directory of [...desiredDirectories].sort(comparePathDepthThenName)) {
    mkdirSync(path.join(stageRoot, ...directory.split("/")), { recursive: true });
  }

  const written = [];
  const reused = [];
  for (const file of desiredFiles) {
    const destination = path.join(stageRoot, ...file.path.split("/"));
    if (writeFileIfChanged(destination, file.content, timestamp)) {
      written.push(file.path);
    } else {
      reused.push(file.path);
    }
  }

  normalizeStageDirectories(stageRoot, desiredDirectories, timestamp);
  assertNoForbiddenStageFiles(stageRoot);

  const manifest = createStageContentsManifest(desiredFiles, sourceDateEpoch);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  mkdirSync(path.dirname(contentsManifestFile), { recursive: true });
  const manifestWritten = writeFileIfChanged(contentsManifestFile, manifestBytes, timestamp);

  return Object.freeze({
    stageRoot,
    contentsManifestFile,
    contentHash: manifest.contentHash,
    files: manifest.files,
    written: Object.freeze(written),
    reused: Object.freeze(reused),
    removed: Object.freeze(removed.sort(compareNames)),
    manifestWritten
  });
}

export function createStageContentsManifest(files, sourceDateEpoch) {
  const normalizedEpoch = validateSourceDateEpoch(sourceDateEpoch);
  const entries = files.map(file => ({
    path: normalizeStagePath(file.path),
    bytes: file.content.length,
    sha256: sha256(file.content)
  })).sort((left, right) => compareNames(left.path, right.path));
  const contentHash = createHash("sha256");
  for (const entry of entries) {
    contentHash.update(JSON.stringify([entry.path, entry.bytes, entry.sha256]));
    contentHash.update("\n");
  }
  return Object.freeze({
    schemaVersion: stageContentsSchemaVersion,
    hashAlgorithm: "sha256",
    sourceDateEpoch: String(normalizedEpoch),
    contentHash: contentHash.digest("hex"),
    files: Object.freeze(entries.map(entry => Object.freeze(entry)))
  });
}

export function validateSourceDateEpoch(value, source = "sourceDateEpoch") {
  const text = typeof value === "number" ? String(value) : value;
  const timestamp = Number(text);
  if (typeof text !== "string" || !/^\d+$/.test(text) || !Number.isSafeInteger(timestamp)
    || timestamp < 315532800 || timestamp > 4354819199) {
    throw new Error(`${source} must be a Unix timestamp supported by ZIP (1980 through 2107).`);
  }
  return timestamp;
}

export function normalizeStagePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("Stage file paths must be non-empty strings without NUL bytes.");
  }
  const slashPath = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(slashPath) || /^[A-Za-z]:/.test(slashPath)) {
    throw new Error(`Stage file path must be relative: ${value}`);
  }
  const normalized = path.posix.normalize(slashPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Stage file path escapes the stage root: ${value}`);
  }
  if (normalized.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Stage file path is not canonical: ${value}`);
  }
  const lower = normalized.toLowerCase();
  if (forbiddenStageSuffixes.some(suffix => lower.endsWith(suffix))) {
    throw new Error(`Forbidden production stage file: ${normalized}`);
  }
  return normalized;
}

function normalizeDesiredFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("A VSIX stage requires at least one allow-listed file.");
  }
  const normalized = [];
  const caseInsensitivePaths = new Map();
  for (const file of files) {
    const relativePath = normalizeStagePath(file?.path);
    const caseInsensitivePath = relativePath.toLowerCase();
    const collision = caseInsensitivePaths.get(caseInsensitivePath);
    if (collision !== undefined) {
      throw new Error(`Duplicate stage path '${relativePath}' collides with '${collision}'.`);
    }
    caseInsensitivePaths.set(caseInsensitivePath, relativePath);
    const content = toBuffer(file?.content, relativePath);
    normalized.push(Object.freeze({ path: relativePath, content }));
  }
  const exactPaths = new Set(normalized.map(file => file.path));
  for (const file of normalized) {
    let parent = path.posix.dirname(file.path);
    while (parent !== ".") {
      if (exactPaths.has(parent)) {
        throw new Error(`Stage file '${parent}' cannot also contain '${file.path}'.`);
      }
      parent = path.posix.dirname(parent);
    }
  }
  return normalized.sort((left, right) => compareNames(left.path, right.path));
}

function toBuffer(content, relativePath) {
  if (Buffer.isBuffer(content)) {
    return content;
  }
  if (typeof content === "string" || content instanceof Uint8Array) {
    return Buffer.from(content);
  }
  throw new Error(`Stage file '${relativePath}' must provide string, Buffer, or Uint8Array content.`);
}

function collectDesiredDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    let directory = path.posix.dirname(file.path);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return directories;
}

function reconcileStageShape(stageRoot, desiredPaths, desiredDirectories) {
  const inventory = scanStage(stageRoot);
  const removed = [];

  for (const entry of inventory.linksAndSpecialFiles) {
    removeStageEntry(stageRoot, entry.path, entry.isDirectory);
    removed.push(entry.path);
  }

  for (const file of inventory.files) {
    if (!desiredPaths.has(file) || desiredDirectories.has(file)) {
      removeStageEntry(stageRoot, file, false);
      removed.push(file);
    }
  }

  for (const directory of inventory.directories.sort(comparePathDepthDescending)) {
    if (!desiredDirectories.has(directory) || desiredPaths.has(directory)) {
      removeStageEntry(stageRoot, directory, true);
      removed.push(directory);
    }
  }

  return [...new Set(removed)];
}

function scanStage(stageRoot) {
  const files = [];
  const directories = [];
  const linksAndSpecialFiles = [];

  const visit = (absoluteDirectory, relativeDirectory) => {
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const details = lstatSync(absolutePath);
      if (details.isSymbolicLink()) {
        linksAndSpecialFiles.push({ path: relativePath, isDirectory: false });
      } else if (details.isDirectory()) {
        directories.push(relativePath);
        visit(absolutePath, relativePath);
      } else if (details.isFile()) {
        files.push(relativePath);
      } else {
        linksAndSpecialFiles.push({ path: relativePath, isDirectory: details.isDirectory() });
      }
    }
  };

  visit(stageRoot, "");
  return { files, directories, linksAndSpecialFiles };
}

function removeStageEntry(stageRoot, relativePath, recursive) {
  const absolutePath = path.resolve(stageRoot, ...relativePath.split("/"));
  assertStrictDescendant(stageRoot, absolutePath, "stage entry");
  rmSync(absolutePath, { recursive, force: true });
}

function writeFileIfChanged(fileName, content, timestamp) {
  if (existsSync(fileName)) {
    const details = lstatSync(fileName);
    if (details.isFile() && readFileSync(fileName).equals(content)) {
      normalizeFileMetadata(fileName, timestamp);
      return false;
    }
    rmSync(fileName, { recursive: details.isDirectory(), force: true });
  }

  mkdirSync(path.dirname(fileName), { recursive: true });
  const temporaryFile = path.join(
    path.dirname(fileName),
    `.${path.basename(fileName)}.stage-${process.pid}-${temporaryFileSequence += 1}.tmp`
  );
  try {
    writeFileSync(temporaryFile, content, { flag: "wx", mode: 0o644 });
    normalizeFileMetadata(temporaryFile, timestamp);
    renameSync(temporaryFile, fileName);
    normalizeFileMetadata(fileName, timestamp);
  } catch (error) {
    rmSync(temporaryFile, { force: true });
    throw error;
  }
  return true;
}

function normalizeFileMetadata(fileName, timestamp) {
  const details = statSync(fileName);
  if (process.platform !== "win32" && (details.mode & 0o777) !== 0o644) {
    chmodSync(fileName, 0o644);
  }
  if (Math.abs(details.mtimeMs - timestamp.getTime()) >= 1) {
    utimesSync(fileName, timestamp, timestamp);
  }
}

function normalizeStageDirectories(stageRoot, desiredDirectories, timestamp) {
  const directories = [...desiredDirectories]
    .sort(comparePathDepthDescending)
    .map(directory => path.join(stageRoot, ...directory.split("/")));
  directories.push(stageRoot);
  for (const directory of directories) {
    const details = statSync(directory);
    if (process.platform !== "win32" && (details.mode & 0o777) !== 0o755) {
      chmodSync(directory, 0o755);
    }
    if (Math.abs(details.mtimeMs - timestamp.getTime()) >= 1) {
      utimesSync(directory, timestamp, timestamp);
    }
  }
}

function assertNoForbiddenStageFiles(stageRoot) {
  for (const file of scanStage(stageRoot).files) {
    const lower = file.toLowerCase();
    if (forbiddenStageSuffixes.some(suffix => lower.endsWith(suffix))) {
      throw new Error(`Forbidden production stage file remained after assembly: ${file}`);
    }
  }
}

function validateExistingStageRoot(stageRoot) {
  if (!existsSync(stageRoot)) {
    return;
  }
  const details = lstatSync(stageRoot);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`VSIX stage root must be a real directory: ${stageRoot}`);
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty path string.`);
  }
  return value;
}

function assertDescendant(parent, target, label) {
  if (!isPathAtOrBelow(parent, target)) {
    throw new Error(`${label} must remain inside ${parent}: ${target}`);
  }
}

function assertStrictDescendant(parent, target, label) {
  assertDescendant(parent, target, label);
  if (samePath(parent, target)) {
    throw new Error(`${label} must not equal its allowed parent: ${target}`);
  }
}

function isPathAtOrBelow(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function comparePathDepthThenName(left, right) {
  const depth = left.split("/").length - right.split("/").length;
  return depth || compareNames(left, right);
}

function comparePathDepthDescending(left, right) {
  const depth = right.split("/").length - left.split("/").length;
  return depth || compareNames(right, left);
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
