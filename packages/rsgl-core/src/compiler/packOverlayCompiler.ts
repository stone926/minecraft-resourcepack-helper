import {
  BlockNode,
  ExprNode,
  OverlayDeclNode,
  PackFilterBlockStmtNode,
  PackFormatsStmtNode,
  PackOverlayStmtNode,
  ResourceDeclNode,
  ResourceStatementNode
} from "../parser";
import {
  packContentFromBody,
  packFormatMetadata,
  packSourceMappings,
  prefixOverlayUnit,
  staticText
} from "./compilerHelpers";
import { isJsonObject } from "./jsonValues";
import { EvaluationContext, EvaluationValue, evaluateExpression } from "./evaluate";
import { JsonValue, ResourceUnit, RsglMapping, RsglSourceMap } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import type { RsglTargetPackFormat } from "./targetConfig";
import { RsglCompileContext } from "./templateExpansion";

export interface RsglOverlayEntry {
  entry: Record<string, JsonValue>;
  source: OverlayDeclNode;
  context: RsglCompileContext;
}

export interface PackOverlayCompileOptions {
  fileName: string;
  targetPackFormat?: RsglTargetPackFormat;
  units: ResourceUnit[];
  overlayEntries: RsglOverlayEntry[];
  onError: (code: string, message: string, range: { start: number; end: number }) => void;
  compileBlock: (body: BlockNode, context: RsglCompileContext) => void;
  createChildContext: (
    context: RsglCompileContext,
    values: Record<string, EvaluationValue>,
    metadata?: Partial<Pick<EvaluationContext, "sourceFile" | "mappingReason" | "expansionStack">>
  ) => RsglCompileContext;
  compilePackBody: (body: ResourceDeclNode["body"], context: RsglCompileContext) => Record<string, JsonValue>;
  compilePackBodyWithMappings: (
    body: ResourceDeclNode["body"],
    context: RsglCompileContext
  ) => { content: Record<string, JsonValue>; mappings: RsglMapping[] };
  sourceMap: (
    outputPath: string,
    node: { range: { start: number; end: number } },
    context: RsglCompileContext,
    mappings: RsglMapping[]
  ) => RsglSourceMap;
}

export function compilePackResource(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  options: PackOverlayCompileOptions
): ResourceUnit {
  const outputPath = "pack.mcmeta";
  const body = options.compilePackBodyWithMappings(statement.body, context);
  const hasExplicitPackRoot = isJsonObject(body.content.pack);
  const content = packContentWithTargetMetadata(packContentFromBody(body.content, hasExplicitPackRoot), options.targetPackFormat);
  return {
    kind: "pack",
    outputPath,
    content,
    mergePolicy: { kind: "mergeObject" },
    sourceMap: options.sourceMap(
      outputPath,
      statement,
      context,
      packSourceMappings(body.mappings, hasExplicitPackRoot)
    )
  };
}

export function compileOverlayDecl(
  statement: OverlayDeclNode,
  context: RsglCompileContext,
  options: PackOverlayCompileOptions
): void {
  const directory = staticText(statement.directory, context);
  if (!directory || !/^[a-z0-9_-]+$/.test(directory)) {
    options.onError("rsgl.invalidOverlayDirectory", "Overlay directory must contain only lowercase letters, numbers, '_' or '-'.", statement.directory.range);
    return;
  }

  const entry: Record<string, JsonValue> = { directory };
  if (statement.formatRange) {
    const range = overlayFormatRange(statement.formatRange, context);
    if (!range) {
      options.onError("rsgl.invalidOverlayFormatRange", "Overlay format must be a number, [major, minor], or [min]..[max] range.", statement.formatRange.range);
      return;
    }
    entry.min_format = range.min;
    entry.max_format = range.max;
  }
  options.overlayEntries.push({ entry, source: statement, context });

  const startIndex = options.units.length;
  const overlayContext = options.createChildContext(context, {}, {
    expansionStack: [
      ...(context.expansionStack ?? []),
      { label: `overlay ${directory}`, sourceRange: statement.range }
    ]
  });
  options.compileBlock(statement.body, overlayContext);
  const overlayUnits = options.units.splice(startIndex);
  for (const unit of overlayUnits) {
    if (unit.outputPath === "pack.mcmeta") {
      options.onError("rsgl.overlayPackMcmetaUnsupported", "Overlay blocks cannot emit pack.mcmeta directly.", unit.sourceMap.mappings[0]?.sourceRange ?? statement.range);
      continue;
    }
    options.units.push(prefixOverlayUnit(unit, directory));
  }
}

export function compilePackSpecialStatement(
  statement: ResourceStatementNode,
  context: RsglCompileContext,
  options: PackOverlayCompileOptions
): Record<string, JsonValue> | undefined {
  if (statement.kind === "PackFormatsStmt") {
    return compilePackFormatsStatement(statement, context, options);
  }
  if (statement.kind === "PackOverlayStmt") {
    return compilePackOverlayStatement(statement, context, options);
  }
  if (statement.kind === "PackFilterBlockStmt") {
    return compilePackFilterBlockStatement(statement, context, options);
  }
  return undefined;
}

export function pushOverlayPackUnit(options: PackOverlayCompileOptions): void {
  if (options.overlayEntries.length === 0) {
    return;
  }
  const outputPath = "pack.mcmeta";
  options.units.push({
    kind: "pack",
    outputPath,
    content: {
      overlays: {
        entries: options.overlayEntries.map(item => item.entry)
      }
    },
    mergePolicy: { kind: "mergeObject" },
    sourceMap: {
      generatedFile: outputPath,
      mappings: options.overlayEntries.map((item, index) => ({
        generatedPath: appendGeneratedPath("/overlays/entries", String(index)),
        sourceFile: item.context.sourceFile ?? options.fileName,
        sourceRange: item.source.range,
        reason: item.context.mappingReason ?? "direct",
        expansionStack: item.context.expansionStack ?? []
      }))
    }
  });
}

function compilePackFormatsStatement(
  statement: PackFormatsStmtNode,
  context: RsglCompileContext,
  options: PackOverlayCompileOptions
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  if (statement.min) {
    const min = packFormatValue(statement.min, context);
    if (min) {
      result.min_format = min;
    } else {
      options.onError("rsgl.invalidPackFormatField", "Pack formats min must be a number or [major, minor] tuple.", statement.min.range);
    }
  }
  if (statement.max) {
    const max = packFormatValue(statement.max, context);
    if (max) {
      result.max_format = max;
    } else {
      options.onError("rsgl.invalidPackFormatField", "Pack formats max must be a number or [major, minor] tuple.", statement.max.range);
    }
  }
  return result;
}

function compilePackOverlayStatement(
  statement: PackOverlayStmtNode,
  context: RsglCompileContext,
  options: PackOverlayCompileOptions
): Record<string, JsonValue> | undefined {
  const directory = staticText(statement.directory, context);
  if (!directory) {
    options.onError("rsgl.invalidOverlayDirectory", "Pack overlay directory must be a static string.", statement.directory.range);
    return undefined;
  }
  const body = options.compilePackBody(statement.body, context);
  return {
    overlays: {
      entries: [{
        directory,
        ...body
      }]
    }
  };
}

function compilePackFilterBlockStatement(
  statement: PackFilterBlockStmtNode,
  context: RsglCompileContext,
  options: PackOverlayCompileOptions
): Record<string, JsonValue> | undefined {
  const namespace = statement.namespace ? staticText(statement.namespace, context) : null;
  const path = statement.path ? staticText(statement.path, context) : null;
  if (!namespace || !path) {
    options.onError("rsgl.invalidPackFilterBlock", "Pack filter block requires static namespace and path patterns.", statement.range);
    return undefined;
  }
  return {
    block: [{
      namespace,
      path
    }]
  };
}

function packContentWithTargetMetadata(
  content: Record<string, JsonValue>,
  targetPackFormat: RsglTargetPackFormat | undefined
): Record<string, JsonValue> {
  if (!targetPackFormat || !isJsonObject(content.pack)) {
    return content;
  }
  const pack = content.pack;
  if ("pack_format" in pack || "supported_formats" in pack || "min_format" in pack || "max_format" in pack) {
    return content;
  }
  return {
    ...content,
    pack: {
      ...pack,
      ...packFormatMetadata(targetPackFormat)
    }
  };
}

function overlayFormatRange(expression: ExprNode, context: RsglCompileContext): { min: JsonValue[]; max: JsonValue[] } | null {
  if (expression.kind === "RangeExpr") {
    const min = packFormatValue(expression.startExpr, context);
    const max = packFormatValue(expression.endExpr, context);
    return min && max ? { min, max } : null;
  }
  const value = packFormatValue(expression, context);
  return value ? { min: value, max: value } : null;
}

function packFormatValue(expression: ExprNode, context: RsglCompileContext): JsonValue[] | null {
  const value = evaluateExpression(expression, context);
  if (typeof value === "number" && Number.isFinite(value)) {
    return [value, 0];
  }
  if (Array.isArray(value) && typeof value[0] === "number") {
    return [value[0], typeof value[1] === "number" ? value[1] : 0];
  }
  return null;
}
