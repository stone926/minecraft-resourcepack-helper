#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleVsixStageTree,
  normalizeStagePath,
  validateSourceDateEpoch
} from "./vsix-stage-tree.mjs";
import {
  combinedVsixRuntimeEntries,
  combinedVsixRuntimeSourceMaps
} from "./combined-vsix-layout.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const defaultRepositoryRoot = path.resolve(scriptDirectory, "..");

export const mainVsixStageLayout = Object.freeze({
  root: "dist/vsix-stage/main",
  contentsManifest: "dist/vsix-stage/main.contents.json"
});

export const mainVsixRuntimeBundles = Object.freeze([
  ...Object.values(combinedVsixRuntimeEntries)
]);

export const mainVsixRuntimeSourceMaps = combinedVsixRuntimeSourceMaps;

export const mainVsixGeneratedIgnore = Object.freeze([
  "**/*.map",
  "**/*.ts",
  "**/*.tsx",
  "**/*.test.*",
  "node_modules/**",
  "src/**",
  "test/**",
  "out/**",
  "dist/**"
]);

export const mainVsixDevelopmentGeneratedIgnore = Object.freeze(
  mainVsixGeneratedIgnore.filter(pattern => pattern !== "**/*.map")
);

export const mainVsixStageBundleModes = Object.freeze(["development", "production"]);

const requiredRootFiles = Object.freeze([
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "icon.png",
  "webviews/modelPreview/styles.css"
]);

const optionalRootFiles = Object.freeze([
  "README_CN.md",
  "ThirdPartyNotices.txt",
  "ThirdPartyNotices.md"
]);

const overlayDirectories = Object.freeze([
  Object.freeze({
    destination: "language-configuration",
    sources: Object.freeze(["language-configuration"])
  }),
  Object.freeze({
    destination: "syntaxes",
    sources: Object.freeze(["syntaxes"])
  }),
  Object.freeze({
    destination: "schemas",
    sources: Object.freeze(["schemas"])
  })
]);

export function assembleMainVsixStage(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const bundleMode = options.bundleMode ?? "production";
  assertMainVsixStageBundleMode(bundleMode);
  const stageRoot = path.resolve(
    options.stageRoot ?? path.join(repositoryRoot, mainVsixStageLayout.root)
  );
  const contentsManifestFile = path.resolve(
    options.contentsManifestFile ?? path.join(repositoryRoot, mainVsixStageLayout.contentsManifest)
  );
  const allowedStageParent = path.join(repositoryRoot, "dist", "vsix-stage");
  const sourceDateEpoch = options.sourceDateEpoch === undefined
    ? resolveMainVsixSourceDateEpoch({ repositoryRoot })
    : validateSourceDateEpoch(options.sourceDateEpoch);
  const files = collectMainVsixStageFiles(repositoryRoot, { bundleMode });

  return assembleVsixStageTree({
    stageRoot,
    allowedStageParent,
    contentsManifestFile,
    sourceDateEpoch,
    files,
    allowedForbiddenPaths: bundleMode === "development" ? mainVsixRuntimeSourceMaps : []
  });
}

export function collectMainVsixStageFiles(repositoryRoot, options = {}) {
  const root = path.resolve(repositoryRoot);
  const bundleMode = options.bundleMode ?? "production";
  assertMainVsixStageBundleMode(bundleMode);
  const jsonIndent = bundleMode === "development" ? 2 : undefined;
  const files = new Map();
  const sourceManifest = readJsonObject(path.join(root, "package.json"), "package.json");
  const publishManifest = createPublishManifest(sourceManifest);
  addGeneratedFile(files, "package.json", `${JSON.stringify(publishManifest, null, 2)}\n`);
  const generatedIgnore = bundleMode === "development"
    ? mainVsixDevelopmentGeneratedIgnore
    : mainVsixGeneratedIgnore;
  addGeneratedFile(files, ".vscodeignore", `${generatedIgnore.join("\n")}\n`);

  for (const relativePath of requiredRootFiles) {
    addRepositoryFile(files, root, relativePath, relativePath, { required: true });
  }
  for (const relativePath of optionalRootFiles) {
    addRepositoryFile(files, root, relativePath, relativePath, { required: false });
  }
  for (const relativePath of mainVsixRuntimeBundles) {
    addRepositoryFile(files, root, relativePath, relativePath, { required: true });
  }
  if (bundleMode === "development") {
    for (const relativePath of mainVsixRuntimeSourceMaps) {
      addRepositoryFile(files, root, relativePath, relativePath, {
        required: true,
        allowForbidden: true
      });
    }
  }

  addJsonFamily(files, root, {
    destinationDirectory: "",
    sourceDirectories: [""],
    filePattern: /^package\.nls(?:\..+)?\.json$/,
    requiredFile: "package.nls.json",
    jsonIndent
  });
  addJsonFamily(files, root, {
    destinationDirectory: "l10n",
    sourceDirectories: ["l10n"],
    filePattern: /^bundle\.l10n(?:\..+)?\.json$/,
    requiredFile: "bundle.l10n.json",
    jsonIndent
  });

  addDirectory(files, root, "assets", "assets", {
    required: true,
    include: relativePath => relativePath.endsWith(".json") || relativePath.endsWith(".svg"),
    transformJson: true,
    jsonIndent
  });
  requireCollectedFile(files, "assets/mcResHelperSidebar.svg");
  requireCollectedPrefix(files, "assets/linters/");
  requireCollectedPrefix(files, "assets/cit/");

  addDirectory(files, root, "licenses", "licenses", {
    required: true,
    include: () => true,
    transformJson: false
  });
  requireCollectedFile(files, "licenses/THREE-LICENSE.txt");

  addDirectory(files, root, "bundle/rsgl/stdlib", "bundle/rsgl/stdlib", {
    required: true,
    include: relativePath => relativePath.endsWith(".rsgl"),
    transformJson: false
  });
  requireCollectedPrefix(files, "bundle/rsgl/stdlib/");

  for (const overlay of overlayDirectories) {
    let found = false;
    for (const sourceDirectory of overlay.sources) {
      if (!existsSync(path.join(root, ...sourceDirectory.split("/")))) {
        continue;
      }
      found = true;
      addDirectory(files, root, sourceDirectory, overlay.destination, {
        required: true,
        include: relativePath => relativePath.endsWith(".json"),
        transformJson: true,
        jsonIndent,
        replace: true
      });
    }
    if (!found) {
      throw new Error(
        `Missing required ${overlay.destination} source; checked ${overlay.sources.join(", ")}.`
      );
    }
    requireCollectedPrefix(files, `${overlay.destination}/`);
  }

  validatePublishManifestFiles(publishManifest, files);
  return [...files.entries()]
    .map(([filePath, content]) => Object.freeze({ path: filePath, content }))
    .sort((left, right) => compareNames(left.path, right.path));
}

export function createPublishManifest(sourceManifest) {
  const manifest = structuredClone(sourceManifest);
  // Every runtime dependency is bundled into one of the isolated entries.
  // Keeping package-manager metadata would make VSCE look for node_modules
  // that are intentionally outside the production allow-list.
  delete manifest.dependencies;
  delete manifest.devDependencies;
  if (isPlainObject(manifest.scripts)) {
    delete manifest.scripts["vscode:prepublish"];
    if (Object.keys(manifest.scripts).length === 0) {
      delete manifest.scripts;
    }
  }
  return manifest;
}

export function resolveMainVsixSourceDateEpoch(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const environment = options.environment ?? process.env;
  if (environment.SOURCE_DATE_EPOCH !== undefined) {
    return validateSourceDateEpoch(environment.SOURCE_DATE_EPOCH, "SOURCE_DATE_EPOCH");
  }

  let commitTimestamp;
  try {
    commitTimestamp = (options.readCommitTimestamp ?? readHeadCommitTimestamp)(repositoryRoot);
  } catch (error) {
    throw new Error(
      "VSIX staging requires SOURCE_DATE_EPOCH or a Git checkout to normalize timestamps.",
      { cause: error }
    );
  }
  return validateSourceDateEpoch(commitTimestamp, "HEAD commit timestamp");
}

function addJsonFamily(files, repositoryRoot, options) {
  const mergedByName = new Map();
  for (const sourceDirectory of options.sourceDirectories) {
    const absoluteDirectory = path.join(repositoryRoot, ...sourceDirectory.split("/").filter(Boolean));
    if (!existsSync(absoluteDirectory)) {
      continue;
    }
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
      .filter(entry => entry.isFile() && options.filePattern.test(entry.name))
      .sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const source = readJsonObject(path.join(absoluteDirectory, entry.name), entry.name);
      const existing = mergedByName.get(entry.name) ?? {};
      mergedByName.set(entry.name, { ...existing, ...source });
    }
  }

  if (!mergedByName.has(options.requiredFile)) {
    throw new Error(`Missing required localized JSON file: ${options.requiredFile}`);
  }
  for (const [fileName, value] of [...mergedByName.entries()].sort(([left], [right]) => compareNames(left, right))) {
    const destination = options.destinationDirectory
      ? `${options.destinationDirectory}/${fileName}`
      : fileName;
    addGeneratedFile(files, destination, stringifyStageJson(value, options.jsonIndent));
  }
}

function addDirectory(files, repositoryRoot, sourceDirectory, destinationDirectory, options) {
  const absoluteSource = path.join(repositoryRoot, ...sourceDirectory.split("/"));
  if (!existsSync(absoluteSource)) {
    if (options.required) {
      throw new Error(`Missing required VSIX stage directory: ${sourceDirectory}`);
    }
    return;
  }
  const details = lstatSync(absoluteSource);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`VSIX stage source must be a real directory: ${sourceDirectory}`);
  }

  const visit = (absoluteDirectory, relativeDirectory) => {
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const entryDetails = lstatSync(absolutePath);
      if (entryDetails.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed in VSIX stage sources: ${sourceDirectory}/${relativePath}`);
      }
      if (entryDetails.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!entryDetails.isFile() || !options.include(relativePath)) {
        continue;
      }
      const destination = normalizeStagePath(`${destinationDirectory}/${relativePath}`);
      const content = options.transformJson && relativePath.endsWith(".json")
        ? Buffer.from(stringifyStageJson(
          readJsonObject(absolutePath, `${sourceDirectory}/${relativePath}`),
          options.jsonIndent
        ))
        : readFileSync(absolutePath);
      addFile(files, destination, content, options.replace === true);
    }
  };
  visit(absoluteSource, "");
}

function addRepositoryFile(files, repositoryRoot, sourcePath, destinationPath, options) {
  const absoluteSource = path.join(repositoryRoot, ...sourcePath.split("/"));
  if (!existsSync(absoluteSource)) {
    if (options.required) {
      throw new Error(`Missing required VSIX stage file: ${sourcePath}`);
    }
    return;
  }
  const details = lstatSync(absoluteSource);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`VSIX stage source must be a real file: ${sourcePath}`);
  }
  addFile(
    files,
    normalizeStagePath(destinationPath, { allowForbidden: options.allowForbidden === true }),
    readFileSync(absoluteSource),
    false
  );
}

function addGeneratedFile(files, destinationPath, content) {
  addFile(files, normalizeStagePath(destinationPath), Buffer.from(content), false);
}

function addFile(files, destination, content, replace) {
  const existing = files.get(destination);
  if (existing !== undefined && !replace) {
    throw new Error(`Duplicate main VSIX allow-list destination: ${destination}`);
  }
  files.set(destination, content);
}

function requireCollectedFile(files, relativePath) {
  if (!files.has(relativePath)) {
    throw new Error(`Required VSIX runtime file was not collected: ${relativePath}`);
  }
}

function requireCollectedPrefix(files, prefix) {
  if (![...files.keys()].some(file => file.startsWith(prefix))) {
    throw new Error(`Required VSIX runtime directory was empty: ${prefix}`);
  }
}

function validatePublishManifestFiles(manifest, files) {
  const references = new Set();
  addManifestReference(references, manifest.main);
  addManifestReference(references, manifest.icon);
  for (const language of manifest.contributes?.languages ?? []) {
    addManifestReference(references, language.configuration);
  }
  for (const grammar of manifest.contributes?.grammars ?? []) {
    addManifestReference(references, grammar.path);
  }
  for (const container of manifest.contributes?.viewsContainers?.activitybar ?? []) {
    addManifestReference(references, container.icon);
  }

  for (const reference of references) {
    if (!files.has(reference)) {
      throw new Error(`Publish manifest references a file outside the main VSIX allow-list: ${reference}`);
    }
  }
}

function addManifestReference(references, value) {
  if (typeof value !== "string" || value.startsWith("$(") || value.includes("%")) {
    return;
  }
  references.add(normalizeStagePath(value.replace(/^\.\//, "")));
}

function readJsonObject(fileName, label) {
  const text = readFileSync(fileName, "utf8").replace(/^\uFEFF/, "");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in VSIX stage source ${label}.`, { cause: error });
  }
  if (!isPlainObject(value)) {
    throw new Error(`VSIX stage JSON source must contain an object: ${label}`);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readHeadCommitTimestamp(repositoryRoot) {
  return execFileSync(
    "git",
    [
      "-c",
      `safe.directory=${repositoryRoot.replaceAll("\\", "/")}`,
      "show",
      "-s",
      "--format=%ct",
      "HEAD"
    ],
    { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseMainVsixStageArguments(args) {
  let sourceDateEpoch;
  let bundleMode = "production";
  let hasBundleMode = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--source-date-epoch") {
      if (sourceDateEpoch !== undefined) {
        throw new Error("--source-date-epoch may only be specified once.");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value after --source-date-epoch.");
      }
      sourceDateEpoch = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--source-date-epoch=")) {
      if (sourceDateEpoch !== undefined) {
        throw new Error("--source-date-epoch may only be specified once.");
      }
      sourceDateEpoch = argument.slice("--source-date-epoch=".length);
      continue;
    }
    if (argument === "--bundle-mode") {
      if (hasBundleMode) {
        throw new Error("--bundle-mode may only be specified once.");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value after --bundle-mode.");
      }
      bundleMode = value;
      hasBundleMode = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--bundle-mode=")) {
      if (hasBundleMode) {
        throw new Error("--bundle-mode may only be specified once.");
      }
      bundleMode = argument.slice("--bundle-mode=".length);
      hasBundleMode = true;
      continue;
    }
    throw new Error(`Unknown VSIX stage argument: ${argument}`);
  }
  assertMainVsixStageBundleMode(bundleMode);
  return { sourceDateEpoch, bundleMode };
}

function stringifyStageJson(value, indent) {
  const serialized = JSON.stringify(value, null, indent);
  return indent === undefined ? serialized : `${serialized}\n`;
}

function assertMainVsixStageBundleMode(bundleMode) {
  if (!mainVsixStageBundleModes.includes(bundleMode)) {
    throw new Error(
      `Unknown VSIX stage bundle mode '${bundleMode}'. Expected ${mainVsixStageBundleModes.join(", ")}.`
    );
  }
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  const invoked = path.resolve(process.argv[1]);
  return process.platform === "win32"
    ? invoked.toLowerCase() === scriptFile.toLowerCase()
    : invoked === scriptFile;
}

if (isMainModule()) {
  const result = assembleMainVsixStage(parseMainVsixStageArguments(process.argv.slice(2)));
  console.log(`main VSIX stage files: ${result.files.length}`);
  console.log(`main VSIX stage content hash: ${result.contentHash}`);
  console.log(`main VSIX stage writes/reuses/removals: ${result.written.length}/${result.reused.length}/${result.removed.length}`);
}
