import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExprNode,
  RsglModule
} from "../parser";
import { evaluateExpression } from "./evaluate";
import type { EvaluationContext, RawGlobLoader } from "./evaluate";
import { createFileGlobLoader } from "./fileGlob";
import { appendGeneratedPath, prefixGeneratedPath } from "./sourcePaths";
import type { RsglProgram, RsglSemanticModel, RsglSourceFile } from "../semantic";
import type { JsonValue, ResourceUnit, RsglCompileDiagnostic, RsglMapping } from "./ir";
import {
  createJsonObject,
  jsonObjectEntries,
  setJsonObjectProperty
} from "./jsonObjectProperties";
import { cloneJsonObject, isJsonObject } from "./jsonValues";
import { evaluationScalarText } from "./evaluatedResourceValues";
import { parseResourceId } from "./resourceIds";
import type { RsglResourceValidationOptions } from "./validation";
import type { RsglTargetPackFormat } from "./targetConfig";
import { rsglPathKey } from "../pathIdentity";
export { normalizeJsonValue } from "./evaluationJsonValues";

export function staticText(expression: ExprNode, context: EvaluationContext): string | null {
  return evaluationScalarText(evaluateExpression(expression, context));
}

export const packRootFields = new Set(["description", "pack_format", "supported_formats", "min_format", "max_format"]);
export const packMcmetaRootFields = new Set(["filter", "overlays"]);

export function packContentFromBody(content: Record<string, JsonValue>, hasExplicitPackRoot: boolean): Record<string, JsonValue> {
  if (hasExplicitPackRoot) {
    const result = cloneJsonObject(content);
    const pack = isJsonObject(result.pack) ? cloneJsonObject(result.pack) : createJsonObject();
    for (const key of packRootFields) {
      if (Object.hasOwn(result, key)) {
        setJsonObjectProperty(pack, key, result[key]);
        delete result[key];
      }
    }
    setJsonObjectProperty(result, "pack", pack);
    return result;
  }

  const pack = createJsonObject();
  const result = createJsonObject();
  for (const [key, value] of jsonObjectEntries(content)) {
    if (packMcmetaRootFields.has(key)) {
      setJsonObjectProperty(result, key, value);
    } else {
      setJsonObjectProperty(pack, key, value);
    }
  }
  const contentWithPack = createJsonObject();
  setJsonObjectProperty(contentWithPack, "pack", pack);
  for (const [key, value] of jsonObjectEntries(result)) {
    setJsonObjectProperty(contentWithPack, key, value);
  }
  return contentWithPack;
}

export function packSourceMappings(mappings: RsglMapping[], hasExplicitPackRoot: boolean): RsglMapping[] {
  if (hasExplicitPackRoot) {
    return mappings.map(mapping =>
      isPackFieldMapping(mapping.generatedPath)
        ? { ...mapping, generatedPath: prefixGeneratedPath(mapping.generatedPath, "/pack") }
        : mapping
    );
  }
  return mappings.map(mapping =>
    isPackMcmetaRootMapping(mapping.generatedPath)
      ? mapping
      : { ...mapping, generatedPath: prefixGeneratedPath(mapping.generatedPath, "/pack") }
  );
}

const compactEquipmentSugarFields = new Set([
  "/texture",
  "/dyeable",
  "/color",
  "/use_player_texture"
]);

export function compactEquipmentSourceMappings(
  mappings: RsglMapping[],
  content?: Record<string, JsonValue>
): RsglMapping[] {
  const retained = mappings.filter(mapping => !compactEquipmentSugarFields.has(mapping.generatedPath));
  const textureOrigin = [...mappings].reverse().find(mapping =>
    mapping.generatedPath === "/texture" && mapping.validationOrigin
  );
  const layers = isJsonObject(content?.layers) ? content.layers : null;
  if (!textureOrigin?.validationOrigin || !layers) {
    return retained;
  }
  const validationMappings: RsglMapping[] = [];
  for (const [layer, entries] of Object.entries(layers)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    entries.forEach((entry, index) => {
      if (!isJsonObject(entry) || typeof entry.texture !== "string") {
        return;
      }
      validationMappings.push({
        ...textureOrigin,
        generatedPath: appendGeneratedPath(
          appendGeneratedPath(appendGeneratedPath("/layers", layer), String(index)),
          "texture"
        ),
        validationOnly: true
      });
    });
  }
  return [...retained, ...validationMappings];
}

function isPackFieldMapping(pathValue: string): boolean {
  const match = /^\/([^/]+)(?:\/|$)/.exec(pathValue);
  return Boolean(match && packRootFields.has(match[1]));
}

function isPackMcmetaRootMapping(pathValue: string): boolean {
  const match = /^\/([^/]+)(?:\/|$)/.exec(pathValue);
  return Boolean(match && packMcmetaRootFields.has(match[1]));
}

export function textContent(value: JsonValue | undefined): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

export function isSafePackRelativePath(outputPath: string): boolean {
  if (outputPath.length === 0 || outputPath.startsWith("/") || /^[A-Za-z]:/.test(outputPath)) {
    return false;
  }
  return outputPath.split("/").every(segment =>
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !/[<>:"|?*]/.test(segment)
  );
}

export function isSafeResourcePath(resourcePath: string): boolean {
  return resourcePath.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function ensureTextExtension(outputPath: string): string {
  const fileName = outputPath.split("/").pop() ?? outputPath;
  return /\.[a-z0-9]+$/i.test(fileName) ? outputPath : `${outputPath}.txt`;
}

function ensureJsonExtension(outputPath: string): string {
  return outputPath.endsWith(".json") ? outputPath : `${outputPath}.json`;
}

export function textResourceTarget(value: string, namespace: string): { id?: { namespace: string; path: string }; outputPath: string } | null {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("assets/")) {
    if (!isSafePackRelativePath(normalized)) {
      return null;
    }
    const outputPath = ensureTextExtension(normalized);
    const assetId = /^assets\/([^/]+)\/(.+)$/.exec(outputPath);
    return {
      id: assetId ? parseResourceId(`${assetId[1]}:${assetId[2]}`, namespace) ?? undefined : undefined,
      outputPath
    };
  }

  const id = parseResourceId(value, namespace);
  if (id && !isSafeResourcePath(id.path)) {
    return null;
  }
  return id ? {
    id,
    outputPath: `assets/${id.namespace}/${ensureTextExtension(id.path)}`
  } : null;
}

export function copyResourceTarget(value: string, namespace: string, packRelative: boolean): { id?: { namespace: string; path: string }; outputPath: string } | null {
  const normalized = value.replace(/\\/g, "/");
  if (packRelative || normalized.startsWith("assets/")) {
    if (!isSafePackRelativePath(normalized)) {
      return null;
    }
    const assetId = /^assets\/([^/]+)\/(.+)$/.exec(normalized);
    return {
      id: assetId ? parseResourceId(`${assetId[1]}:${assetId[2]}`, namespace) ?? undefined : undefined,
      outputPath: normalized
    };
  }

  const id = parseResourceId(value, namespace);
  if (id && !isSafeResourcePath(id.path)) {
    return null;
  }
  return id ? {
    id,
    outputPath: `assets/${id.namespace}/${id.path}`
  } : null;
}

export function jsonResourceTarget(value: string, namespace: string, packRelative: boolean): { id?: { namespace: string; path: string }; outputPath: string } | null {
  const normalized = value.replace(/\\/g, "/");
  if (packRelative || normalized.startsWith("assets/")) {
    const outputPath = ensureJsonExtension(normalized);
    if (!isSafePackRelativePath(outputPath)) {
      return null;
    }
    const assetId = /^assets\/([^/]+)\/(.+)$/.exec(outputPath);
    return {
      id: assetId ? parseResourceId(`${assetId[1]}:${assetId[2]}`, namespace) ?? undefined : undefined,
      outputPath
    };
  }

  const id = parseResourceId(value, namespace);
  if (id && !isSafeResourcePath(id.path)) {
    return null;
  }
  return id ? {
    id,
    outputPath: `assets/${id.namespace}/${ensureJsonExtension(id.path)}`
  } : null;
}

export function isPackRelativeTargetExpression(expression: ExprNode): boolean {
  return expression.kind === "StringLiteral" || expression.kind === "TemplateStringExpr";
}

export function copySourcePath(value: JsonValue | undefined, sourceFile: string | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const normalized = value.replace(/\\/g, path.sep);
  return path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(sourceBaseDirectory(sourceFile), normalized);
}

function sourceBaseDirectory(sourceFile: string | undefined): string {
  if (!sourceFile || sourceFile.startsWith("<")) {
    return process.cwd();
  }
  return path.dirname(path.resolve(sourceFile));
}

export function isExistingFile(fileName: string): boolean {
  try {
    return fs.statSync(fileName).isFile();
  } catch {
    return false;
  }
}

export function normalizeMcmetaOutputPath(outputPath: string): string {
  return outputPath.endsWith(".mcmeta") ? outputPath : `${outputPath}.mcmeta`;
}

export function prefixOverlayUnit(unit: ResourceUnit, directory: string): ResourceUnit {
  const outputPath = `${directory}/${unit.outputPath.replace(/\\/g, "/")}`;
  return {
    ...unit,
    outputPath,
    sourceMap: {
      ...unit.sourceMap,
      generatedFile: outputPath
    }
  };
}

export function blockstateVariantPath(key: string): string {
  return appendGeneratedPath("/variants", key);
}

export function blockstateMultipartPath(index: number): string {
  return appendGeneratedPath("/multipart", String(index));
}

export function selectProgramModels(program: RsglProgram, entryFileName: string | undefined): RsglSemanticModel[] {
  if (!entryFileName) {
    return program.models;
  }
  const entryKey = rsglPathKey(entryFileName);
  return program.models.filter(model => rsglPathKey(model.fileName) === entryKey);
}

export function detectOutputConflicts(units: ResourceUnit[]): RsglCompileDiagnostic[] {
  const diagnostics: RsglCompileDiagnostic[] = [];
  const seen = new Map<string, ResourceUnit>();
  for (const unit of units) {
    const existing = seen.get(unit.outputPath);
    if (existing) {
      diagnostics.push({
        code: "rsgl.outputConflict",
        message: `Multiple RSGL resources emit ${unit.outputPath}.`,
        range: unit.sourceMap.mappings[0]?.sourceRange ?? { start: 0, end: 1 },
        severity: "error",
        fileName: unit.sourceMap.mappings[0]?.sourceFile
      });
    } else {
      seen.set(unit.outputPath, unit);
    }
  }
  return diagnostics;
}

export function withTargetPackFormat<T extends RsglResourceValidationOptions>(
  options: T,
  targetPackFormat: RsglTargetPackFormat | undefined
): T {
  return options.targetPackFormat || !targetPackFormat
    ? options
    : { ...options, targetPackFormat };
}

export function packFormatMetadata(target: RsglTargetPackFormat): Record<string, JsonValue> {
  if (target.major >= 65) {
    return {
      ["min_format"]: [target.major, target.minor ?? 0],
      ["max_format"]: [target.major, target.minor ?? 0]
    };
  }
  return { ["pack_format"]: target.major };
}

export function createCompileGlobLoader(fallbackFileName: string, diagnostics: RsglCompileDiagnostic[]): RawGlobLoader {
  return createFileGlobLoader({
    fallbackFileName,
    onError: (code, message, range) => diagnostics.push({ code, message, range, severity: "error" })
  });
}

export function moduleSyntaxDiagnostics(module: RsglModule, fileName: string | undefined): RsglCompileDiagnostic[] {
  return module.diagnostics.map(diagnostic => ({
    code: diagnostic.code,
    message: diagnostic.message,
    range: diagnostic.range,
    severity: diagnostic.severity,
    fileName
  }));
}

export function hasErrors(diagnostics: RsglCompileDiagnostic[]): boolean {
  return diagnostics.some(diagnostic => diagnostic.severity === "error");
}

export function semanticProgramMatchesFiles(
  program: RsglProgram | undefined,
  files: RsglSourceFile[],
  expectedSemanticConfigurationFingerprint?: string
): program is RsglProgram {
  return program !== undefined
    && program.semanticConfigurationFingerprint === expectedSemanticConfigurationFingerprint
    && program.files.length === files.length
    && program.files.every((file, index) => file === files[index]);
}

/** Selects the entry module and its transitive imports for project target resolution. */
export function selectProgramTargetModels(
  program: RsglProgram,
  entryFileName: string | undefined
): RsglSemanticModel[] {
  if (!entryFileName) {
    return program.models;
  }

  const outgoing = new Map<string, string[]>();
  for (const edge of program.importGraph.edges) {
    const from = rsglPathKey(edge.from);
    const targets = outgoing.get(from) ?? [];
    targets.push(rsglPathKey(edge.to));
    outgoing.set(from, targets);
  }

  const reachable = new Set<string>();
  const pending = [rsglPathKey(entryFileName)];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }

  return program.models.filter(model => reachable.has(rsglPathKey(model.fileName)));
}
