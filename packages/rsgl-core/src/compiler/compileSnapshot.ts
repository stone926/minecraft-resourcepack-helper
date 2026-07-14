import * as path from "node:path";
import { getRsglResourceKindDescriptor } from "../resourceKinds";
import { orderJsonValue } from "./emit";
import {
  isExternalResourceUnit,
  type JsonValue,
  type ResourceContent,
  type ResourceUnit,
  type RsglCompileDiagnostic,
  type RsglCompileResult,
  type RsglMapping
} from "./ir";

export const rsglCompileSnapshotVersion = 1;

export interface RsglCompileSnapshotOptions {
  /** Makes source file names within this root portable across machines and operating systems. */
  sourceRoot?: string;
  /** Maps additional source roots (for example shared imports) onto stable snapshot prefixes. */
  sourceFileAliases?: readonly RsglCompileSnapshotSourceAlias[];
  /** External dependency marker units are excluded from regression snapshots by default. */
  includeExternalUnits?: boolean;
}

export interface RsglCompileSnapshotSourceAlias {
  root: string;
  prefix: string;
}

export interface RsglCompileSnapshot {
  version: typeof rsglCompileSnapshotVersion;
  resources: RsglCompileSnapshotResource[];
  diagnostics: RsglCompileSnapshotDiagnostic[];
}

export interface RsglCompileSnapshotResource {
  outputPath: string;
  kind: ResourceUnit["kind"];
  id?: string;
  content: ResourceContent;
  sourceMap: {
    generatedFile: string;
    mappings: RsglCompileSnapshotMapping[];
  };
}

export interface RsglCompileSnapshotMapping {
  generatedPath: string;
  sourceFile: string;
  reason: RsglMapping["reason"];
  validationOnly: boolean;
  expansionStack: string[];
}

export interface RsglCompileSnapshotDiagnostic {
  code: string;
  severity: RsglCompileDiagnostic["severity"];
  fileName?: string;
}

/**
 * Projects a compiler result onto stable regression behavior. Character ranges
 * are intentionally omitted because harmless source edits move tokens; dedicated
 * tests remain responsible for checking that ranges land on the correct token.
 */
export function createRsglCompileSnapshot(
  result: RsglCompileResult,
  options: RsglCompileSnapshotOptions = {}
): RsglCompileSnapshot {
  const normalizeSourceFile = createSourceFileNormalizer(options.sourceRoot, options.sourceFileAliases);
  const resources = result.units
    .filter(unit => options.includeExternalUnits || !isExternalResourceUnit(unit))
    .map(unit => snapshotResource(unit, normalizeSourceFile))
    .sort((left, right) => compareOrdinal(left.outputPath, right.outputPath));

  return {
    version: rsglCompileSnapshotVersion,
    resources,
    diagnostics: result.diagnostics
      .map(diagnostic => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        ...(diagnostic.fileName
          ? { fileName: normalizeSourceFile(diagnostic.fileName) }
          : {})
      }))
      .sort(compareDiagnostics)
  };
}

function snapshotResource(
  unit: ResourceUnit,
  normalizeSourceFile: (fileName: string) => string
): RsglCompileSnapshotResource {
  return {
    outputPath: normalizePortablePath(unit.outputPath),
    kind: unit.kind,
    ...(unit.id ? { id: `${unit.id.namespace}:${unit.id.path}` } : {}),
    content: snapshotContent(unit),
    sourceMap: {
      generatedFile: normalizePortablePath(unit.sourceMap.generatedFile),
      mappings: unit.sourceMap.mappings.map(mapping => ({
        generatedPath: mapping.generatedPath,
        sourceFile: normalizeSourceFile(mapping.sourceFile),
        reason: mapping.reason,
        validationOnly: mapping.validationOnly === true,
        expansionStack: mapping.expansionStack.map(frame => frame.label)
      }))
    }
  };
}

function snapshotContent(unit: ResourceUnit): ResourceContent {
  const contentKind = getRsglResourceKindDescriptor(unit.kind)?.emit.contentKind;
  return contentKind === "json"
    ? orderJsonValue(unit.content as JsonValue, unit.kind)
    : unit.content;
}

function createSourceFileNormalizer(
  sourceRoot: string | undefined,
  aliases: readonly RsglCompileSnapshotSourceAlias[] | undefined
): (fileName: string) => string {
  const resolvedRoot = sourceRoot ? path.resolve(sourceRoot) : undefined;
  const resolvedAliases = aliases?.map(alias => ({
    root: path.resolve(alias.root),
    prefix: normalizePortablePath(alias.prefix).replace(/\/$/, "")
  })) ?? [];
  return fileName => {
    if (isVirtualFileName(fileName)) {
      return normalizePortablePath(fileName);
    }

    const resolvedFileName = path.resolve(fileName);
    if (!resolvedRoot) {
      const aliased = aliasedSourceFile(resolvedFileName, resolvedAliases);
      return aliased ?? normalizePortablePath(resolvedFileName);
    }

    const relative = path.relative(resolvedRoot, resolvedFileName);
    if (isPathWithinRoot(relative)) {
      return normalizePortablePath(relative || ".");
    }
    return aliasedSourceFile(resolvedFileName, resolvedAliases) ?? normalizePortablePath(resolvedFileName);
  };
}

function aliasedSourceFile(
  resolvedFileName: string,
  aliases: readonly { root: string; prefix: string }[]
): string | undefined {
  for (const alias of aliases) {
    const relative = path.relative(alias.root, resolvedFileName);
    if (isPathWithinRoot(relative)) {
      const suffix = normalizePortablePath(relative || ".");
      return alias.prefix ? `${alias.prefix}/${suffix}` : suffix;
    }
  }
  return undefined;
}

function isVirtualFileName(fileName: string): boolean {
  return fileName.startsWith("<") || fileName === "rsgl.config.json";
}

function isPathWithinRoot(relativePath: string): boolean {
  return relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function normalizePortablePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDiagnostics(
  left: RsglCompileSnapshotDiagnostic,
  right: RsglCompileSnapshotDiagnostic
): number {
  return compareOrdinal(left.fileName ?? "", right.fileName ?? "")
    || compareOrdinal(left.code, right.code)
    || compareOrdinal(left.severity, right.severity);
}
