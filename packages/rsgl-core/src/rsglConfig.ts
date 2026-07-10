import * as fs from "node:fs";
import * as path from "node:path";
import { parseExternResourcePattern, type RsglGlobalExternConfigEntry } from "./externDeclarations";
import { isExternResourceKind, rsglExternResourceKinds } from "./resourceKinds";

/** Validated contents of rsgl.config.json. */
export interface RsglProjectConfig {
  root?: string;
  outDir?: string;
  emitSourceMap?: boolean;
  manifest?: boolean;
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
  extern?: RsglGlobalExternConfigEntry[];
  checkExternExistence?: boolean;
}

export interface LoadedRsglProjectConfig {
  fileName: string;
  config: RsglProjectConfig;
}

export type RsglProjectConfigAnchorKind = "file" | "directory";

const configProperties = new Set([
  "root",
  "outDir",
  "emitSourceMap",
  "manifest",
  "defaultAssetsPath",
  "resourcePackRoots",
  "extern",
  "checkExternExistence"
]);

const externEntryProperties = new Set(["source", "kind", "patterns", "checkExistence"]);

/** Validates and normalizes the parsed contents of rsgl.config.json. */
export function parseRsglProjectConfig(value: unknown, configPath = "rsgl.config.json"): RsglProjectConfig {
  const config = requireObject(value, configPath);
  rejectUnknownProperties(config, configProperties, configPath);
  return {
    root: optionalString(config.root, `${configPath}.root`),
    outDir: optionalString(config.outDir, `${configPath}.outDir`),
    emitSourceMap: optionalBoolean(config.emitSourceMap, `${configPath}.emitSourceMap`),
    manifest: optionalBoolean(config.manifest, `${configPath}.manifest`),
    defaultAssetsPath: optionalNullableString(config.defaultAssetsPath, `${configPath}.defaultAssetsPath`),
    resourcePackRoots: optionalStringArray(config.resourcePackRoots, `${configPath}.resourcePackRoots`),
    extern: parseExternEntries(config.extern, `${configPath}.extern`),
    checkExternExistence: optionalBoolean(config.checkExternExistence, `${configPath}.checkExternExistence`)
  };
}

export function readRsglProjectConfig(fileName: string): RsglProjectConfig {
  const resolvedFileName = path.resolve(fileName);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(resolvedFileName, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read ${resolvedFileName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  return resolveRsglProjectConfigPaths(parseRsglProjectConfig(value, resolvedFileName), resolvedFileName);
}

/** Finds and reads the closest rsgl.config.json above a source file. */
export function loadRsglProjectConfigForSource(sourceFileName: string): LoadedRsglProjectConfig | null {
  const fileName = findRsglProjectConfig(sourceFileName);
  return fileName ? { fileName, config: readRsglProjectConfig(fileName) } : null;
}

export function findRsglProjectConfig(sourceFileName: string): string | null {
  const resolvedSource = path.resolve(sourceFileName);
  for (const candidate of projectConfigCandidates(
    resolvedSource,
    isDirectory(resolvedSource) ? "directory" : "file"
  )) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Returns the exact config-file paths that can change the nearest config for
 * an anchor. Candidates stop at the currently nearest existing config; when
 * none exists they continue through the filesystem root.
 */
export function getRsglProjectConfigWatchPaths(
  sourceFileName: string,
  anchorKind: RsglProjectConfigAnchorKind
): string[] {
  const candidates: string[] = [];
  for (const candidate of projectConfigCandidates(path.resolve(sourceFileName), anchorKind)) {
    candidates.push(candidate);
    if (fileExists(candidate)) {
      break;
    }
  }
  return candidates;
}

export function resolveRsglProjectConfigPaths(
  config: RsglProjectConfig,
  configFileName: string
): RsglProjectConfig {
  const baseDirectory = path.dirname(path.resolve(configFileName));
  const resolveOptionalPath = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : path.resolve(baseDirectory, value);
  return {
    ...config,
    root: resolveOptionalPath(config.root),
    outDir: resolveOptionalPath(config.outDir),
    defaultAssetsPath: config.defaultAssetsPath === null
      ? null
      : resolveOptionalPath(config.defaultAssetsPath),
    resourcePackRoots: config.resourcePackRoots?.map(root => path.resolve(baseDirectory, root))
  };
}

function parseExternEntries(value: unknown, fieldPath: string): RsglGlobalExternConfigEntry[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidConfig(fieldPath, "expected an array.");
  }
  return value.map((entry, index) => parseExternEntry(entry, `${fieldPath}[${index}]`));
}

function parseExternEntry(value: unknown, fieldPath: string): RsglGlobalExternConfigEntry {
  const entry = requireObject(value, fieldPath);
  rejectUnknownProperties(entry, externEntryProperties, fieldPath);
  if (entry.source !== "custom" && entry.source !== "vanilla") {
    throw invalidConfig(`${fieldPath}.source`, "expected 'custom' or 'vanilla'.");
  }
  if (typeof entry.kind !== "string" || !isExternResourceKind(entry.kind)) {
    throw invalidConfig(
      `${fieldPath}.kind`,
      `expected one of ${rsglExternResourceKinds.map(kind => `'${kind}'`).join(", ")}.`
    );
  }
  if (!Array.isArray(entry.patterns)) {
    throw invalidConfig(`${fieldPath}.patterns`, "expected an array.");
  }
  if (entry.patterns.length === 0) {
    throw invalidConfig(`${fieldPath}.patterns`, "expected at least one pattern.");
  }
  const patterns = entry.patterns.map((pattern, index) => {
    const patternPath = `${fieldPath}.patterns[${index}]`;
    if (typeof pattern !== "string") {
      throw invalidConfig(patternPath, "expected a string.");
    }
    const parsed = parseExternResourcePattern(pattern);
    if (!parsed.pattern) {
      throw invalidConfig(patternPath, parsed.error ?? "invalid extern resource pattern.");
    }
    return pattern;
  });
  const checkExistence = optionalBoolean(entry.checkExistence, `${fieldPath}.checkExistence`);
  return {
    source: entry.source,
    kind: entry.kind,
    patterns,
    ...(checkExistence === undefined ? {} : { checkExistence })
  };
}

function requireObject(value: unknown, fieldPath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidConfig(fieldPath, "expected an object.");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownProperties(
  value: Record<string, unknown>,
  knownProperties: ReadonlySet<string>,
  fieldPath: string
): void {
  for (const property of Object.keys(value)) {
    if (!knownProperties.has(property)) {
      throw invalidConfig(`${fieldPath}.${property}`, "unknown property.");
    }
  }
}

function optionalString(value: unknown, fieldPath: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidConfig(fieldPath, "expected a string.");
  }
  return value;
}

function optionalNullableString(value: unknown, fieldPath: string): string | null | undefined {
  return value === null ? null : optionalString(value, fieldPath);
}

function optionalBoolean(value: unknown, fieldPath: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw invalidConfig(fieldPath, "expected a boolean.");
  }
  return value;
}

function optionalStringArray(value: unknown, fieldPath: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidConfig(fieldPath, "expected an array.");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw invalidConfig(`${fieldPath}[${index}]`, "expected a string.");
    }
    return entry;
  });
}

function invalidConfig(fieldPath: string, message: string): Error {
  return new Error(`Invalid ${fieldPath}: ${message}`);
}

function* projectConfigCandidates(
  resolvedSource: string,
  anchorKind: RsglProjectConfigAnchorKind
): Generator<string> {
  let directory = anchorKind === "directory" ? resolvedSource : path.dirname(resolvedSource);
  while (true) {
    yield path.join(directory, "rsgl.config.json");
    const parent = path.dirname(directory);
    if (parent === directory) {
      return;
    }
    directory = parent;
  }
}

function fileExists(fileName: string): boolean {
  try {
    return fs.statSync(fileName).isFile();
  } catch {
    return false;
  }
}

function isDirectory(fileName: string): boolean {
  try {
    return fs.statSync(fileName).isDirectory();
  } catch {
    return false;
  }
}
