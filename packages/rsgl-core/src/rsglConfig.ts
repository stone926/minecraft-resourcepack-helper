import * as fs from "node:fs";
import * as path from "node:path";
import { findPackRoot, isValidMinecraftNamespace } from "../../mc-assets/src";
import { parseExternResourcePattern, type RsglGlobalExternConfigEntry } from "./externDeclarations";
import { isExternResourceKind, rsglExternResourceKinds } from "./resourceKinds";
import type { RsglEmitOptions } from "./compiler/emit";
import type { RsglCompileConfigurationOptions } from "./compiler/compileConfiguration";
import {
  isRsglMinecraftVersionText,
  normalizeRsglProjectTarget,
  rsglTargetPackFormatForMinecraftVersion,
  type RsglTargetConfig
} from "./compiler/targetConfig";

/** Validated contents of rsgl.config.json. */
export interface RsglProjectConfig {
  root?: string;
  outDir?: string;
  emitSourceMap?: boolean;
  manifest?: boolean;
  vanillaResourcePackPath?: string | null;
  customResourcePackPaths?: string[];
  /** @deprecated Use `vanillaResourcePackPath`. Accepted for programmatic compatibility. */
  defaultAssetsPath?: string | null;
  /** @deprecated Use `customResourcePackPaths`. Accepted for programmatic compatibility. */
  resourcePackRoots?: string[];
  extern?: RsglGlobalExternConfigEntry[];
  checkExternExistence?: boolean;
  namespace?: string;
  target?: RsglTargetConfig;
  maxEvaluationItems?: number;
  maxItemModelDepth?: number;
}

/** Internal compile options contributed by a validated public project config. */
export type RsglProjectCompileOptions = Pick<
  RsglCompileConfigurationOptions,
  "defaultNamespace" | "projectTarget" | "maxEvaluationItems" | "maxItemModelDepth"
>;

/** Output options derived from the public project configuration. */
export type RsglProjectEmitOptions = Required<Pick<RsglEmitOptions, "sourceMaps" | "manifest">>;

export interface LoadedRsglProjectConfig {
  fileName: string;
  config: RsglProjectConfig;
}

export type RsglProjectConfigAnchorKind = "file" | "directory";

/** Structured validation failure for one public project-config field. */
export class RsglProjectConfigError extends Error {
  public override readonly name = "RsglProjectConfigError";
  public relativeFieldPath: string | undefined;

  public constructor(
    public readonly fieldPath: string,
    message: string
  ) {
    super(`Invalid ${fieldPath}: ${message}`);
  }

  /** Records a filesystem-independent field path for diagnostic classification. */
  public attachConfigPath(configPath: string): void {
    this.relativeFieldPath = this.fieldPath === configPath
      ? ""
      : this.fieldPath.startsWith(`${configPath}.`)
        ? this.fieldPath.slice(configPath.length + 1)
        : undefined;
  }
}

const configProperties = new Set([
  "root",
  "outDir",
  "emitSourceMap",
  "manifest",
  "vanillaResourcePackPath",
  "customResourcePackPaths",
  "defaultAssetsPath",
  "resourcePackRoots",
  "extern",
  "checkExternExistence",
  "namespace",
  "target",
  "maxEvaluationItems",
  "maxItemModelDepth"
]);

const externEntryProperties = new Set(["source", "kind", "patterns", "checkExistence"]);
const targetProperties = new Set(["edition", "format", "mc"]);

/** Validates and normalizes the parsed contents of rsgl.config.json. */
export function parseRsglProjectConfig(value: unknown, configPath = "rsgl.config.json"): RsglProjectConfig {
  try {
    return parseRsglProjectConfigValue(value, configPath);
  } catch (error) {
    if (error instanceof RsglProjectConfigError) {
      error.attachConfigPath(configPath);
    }
    throw error;
  }
}

function parseRsglProjectConfigValue(value: unknown, configPath: string): RsglProjectConfig {
  const config = requireObject(value, configPath);
  rejectUnknownProperties(config, configProperties, configPath);
  const vanillaResourcePack = canonicalConfigField(
    config,
    "vanillaResourcePackPath",
    "defaultAssetsPath",
    configPath
  );
  const customResourcePacks = canonicalConfigField(
    config,
    "customResourcePackPaths",
    "resourcePackRoots",
    configPath
  );
  return {
    root: optionalString(config.root, `${configPath}.root`),
    outDir: optionalString(config.outDir, `${configPath}.outDir`),
    emitSourceMap: optionalBoolean(config.emitSourceMap, `${configPath}.emitSourceMap`),
    manifest: optionalBoolean(config.manifest, `${configPath}.manifest`),
    vanillaResourcePackPath: optionalNullableString(
      vanillaResourcePack.value,
      vanillaResourcePack.fieldPath
    ),
    customResourcePackPaths: optionalStringArray(
      customResourcePacks.value,
      customResourcePacks.fieldPath
    ),
    extern: parseExternEntries(config.extern, `${configPath}.extern`),
    checkExternExistence: optionalBoolean(config.checkExternExistence, `${configPath}.checkExternExistence`),
    namespace: optionalNamespace(config.namespace, `${configPath}.namespace`),
    target: parseTargetConfig(config.target, `${configPath}.target`),
    maxEvaluationItems: optionalPositiveSafeInteger(
      config.maxEvaluationItems,
      `${configPath}.maxEvaluationItems`
    ),
    maxItemModelDepth: optionalPositiveSafeInteger(
      config.maxItemModelDepth,
      `${configPath}.maxItemModelDepth`
    )
  };
}

/** Explicitly maps public config keys to their differently named compiler counterparts. */
export function projectCompileOptionsFromRsglConfig(
  config: RsglProjectConfig
): RsglProjectCompileOptions {
  const options: RsglProjectCompileOptions = {};
  if (config.namespace !== undefined) {
    options.defaultNamespace = config.namespace;
  }
  if (config.target !== undefined) {
    options.projectTarget = normalizeRsglProjectTarget(config.target);
  }
  if (config.maxEvaluationItems !== undefined) {
    options.maxEvaluationItems = config.maxEvaluationItems;
  }
  if (config.maxItemModelDepth !== undefined) {
    options.maxItemModelDepth = config.maxItemModelDepth;
  }
  return options;
}

/** Explicitly maps public output keys to compiler emit options and their defaults. */
export function projectEmitOptionsFromRsglConfig(
  config: RsglProjectConfig
): RsglProjectEmitOptions {
  return {
    sourceMaps: config.emitSourceMap ?? true,
    manifest: config.manifest ?? true
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
  try {
    return resolveRsglProjectConfigPaths(parseRsglProjectConfig(value, resolvedFileName), resolvedFileName);
  } catch (error) {
    if (error instanceof RsglProjectConfigError) {
      error.attachConfigPath(resolvedFileName);
    }
    throw error;
  }
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
  const vanillaResourcePackPath = projectVanillaResourcePackPath(config);
  const customResourcePackPaths = projectCustomResourcePackPaths(config);
  const canonicalConfig = { ...config };
  delete canonicalConfig.defaultAssetsPath;
  delete canonicalConfig.resourcePackRoots;
  return {
    ...canonicalConfig,
    root: resolveOptionalPath(config.root),
    outDir: config.outDir === undefined
      ? undefined
      : assertRsglOutputPackRoot(resolveOptionalPath(config.outDir)!, `${configFileName}.outDir`),
    vanillaResourcePackPath: vanillaResourcePackPath === null
      ? null
      : resolveOptionalPath(vanillaResourcePackPath),
    customResourcePackPaths: customResourcePackPaths?.map(root => path.resolve(baseDirectory, root))
  };
}

/** Returns the canonical vanilla pack path, falling back to its legacy API alias. */
export function projectVanillaResourcePackPath(
  config: RsglProjectConfig
): string | null | undefined {
  return config.vanillaResourcePackPath !== undefined
    ? config.vanillaResourcePackPath
    : config.defaultAssetsPath;
}

/** Returns canonical custom-pack paths, falling back to their legacy API alias. */
export function projectCustomResourcePackPaths(
  config: RsglProjectConfig
): string[] | undefined {
  return config.customResourcePackPaths !== undefined
    ? config.customResourcePackPaths
    : config.resourcePackRoots;
}

/**
 * Normalizes and validates an RSGL output destination as a resource-pack root.
 * Compiler output paths already start with `assets/`, so accepting an assets
 * directory here would otherwise create `assets/assets/...`.
 */
export function assertRsglOutputPackRoot(
  outputRoot: string,
  fieldPath = "outDir"
): string {
  const resolved = path.resolve(outputRoot);
  if (path.basename(resolved).toLowerCase() === "assets") {
    throw invalidConfig(fieldPath, "expected a resource-pack root, not an assets directory.");
  }
  return resolved;
}

/** Resolves the canonical target pack without deriving it from an `assets/` path. */
export function resolveRsglOutputPackRoot(
  sourceFileName: string,
  configuredOutDir?: string | null
): string | null {
  if (configuredOutDir) {
    return assertRsglOutputPackRoot(configuredOutDir);
  }
  const source = path.resolve(sourceFileName);
  const anchor = isDirectory(source) ? path.join(source, ".rsgl-pack-root-anchor") : source;
  return findPackRoot(anchor);
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

function parseTargetConfig(value: unknown, fieldPath: string): RsglTargetConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const target = requireObject(value, fieldPath);
  rejectUnknownProperties(target, targetProperties, fieldPath);
  if (target.edition !== "java") {
    throw invalidConfig(`${fieldPath}.edition`, "expected 'java'.");
  }

  const hasFormat = Object.prototype.hasOwnProperty.call(target, "format");
  const hasMinecraftVersion = Object.prototype.hasOwnProperty.call(target, "mc");
  if (hasFormat === hasMinecraftVersion) {
    throw invalidConfig(fieldPath, "expected exactly one of 'format' or 'mc'.");
  }

  if (hasFormat) {
    return {
      edition: "java",
      format: parseTargetFormat(target.format, `${fieldPath}.format`)
    };
  }

  if (typeof target.mc !== "string") {
    throw invalidConfig(`${fieldPath}.mc`, "expected a Minecraft version string.");
  }
  if (!isRsglMinecraftVersionText(target.mc)) {
    throw invalidConfig(`${fieldPath}.mc`, "expected a version like '1.21.4'.");
  }
  if (!rsglTargetPackFormatForMinecraftVersion(target.mc)) {
    throw invalidConfig(`${fieldPath}.mc`, `unknown Minecraft version '${target.mc}'.`);
  }
  return { edition: "java", mc: target.mc };
}

function parseTargetFormat(value: unknown, fieldPath: string): number | [number, number] {
  if (typeof value === "number") {
    return requirePositiveSafeInteger(value, fieldPath);
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalidConfig(fieldPath, "expected a positive integer or [major, minor] pair.");
  }
  return [
    requirePositiveSafeInteger(value[0], `${fieldPath}[0]`),
    requireNonNegativeSafeInteger(value[1], `${fieldPath}[1]`)
  ];
}

function parseExternEntry(value: unknown, fieldPath: string): RsglGlobalExternConfigEntry {
  const entry = requireObject(value, fieldPath);
  rejectUnknownProperties(entry, externEntryProperties, fieldPath);
  if (entry.source !== "local" && entry.source !== "custom" && entry.source !== "vanilla") {
    throw invalidConfig(`${fieldPath}.source`, "expected 'local', 'custom', or 'vanilla'.");
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

function canonicalConfigField(
  config: Record<string, unknown>,
  canonicalName: string,
  legacyName: string,
  configPath: string
): { value: unknown; fieldPath: string } {
  const hasCanonical = Object.prototype.hasOwnProperty.call(config, canonicalName);
  return hasCanonical
    ? { value: config[canonicalName], fieldPath: `${configPath}.${canonicalName}` }
    : { value: config[legacyName], fieldPath: `${configPath}.${legacyName}` };
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

function optionalNamespace(value: unknown, fieldPath: string): string | undefined {
  const namespace = optionalString(value, fieldPath);
  if (namespace !== undefined && !isValidMinecraftNamespace(namespace)) {
    throw invalidConfig(
      fieldPath,
      "expected a valid lowercase Minecraft namespace using letters, digits, '_', '-', or '.'."
    );
  }
  return namespace;
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

function optionalPositiveSafeInteger(value: unknown, fieldPath: string): number | undefined {
  return value === undefined ? undefined : requirePositiveSafeInteger(value, fieldPath);
}

function requirePositiveSafeInteger(value: unknown, fieldPath: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidConfig(fieldPath, "expected a positive safe integer.");
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, fieldPath: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidConfig(fieldPath, "expected a non-negative safe integer.");
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

function invalidConfig(fieldPath: string, message: string): RsglProjectConfigError {
  return new RsglProjectConfigError(fieldPath, message);
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
