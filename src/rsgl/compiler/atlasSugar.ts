import {
  AtlasDirectoryStmtNode,
  AtlasFilterStmtNode,
  AtlasPalettedPermutationsStmtNode,
  ExprNode,
  ResourceBodyNode,
  ResourceStatementNode,
  TextRange
} from "../parser";
import { EvaluationContext, evaluateExpression } from "./evaluate";
import { JsonValue } from "./ir";
import { ResourceBodyFragment, ResourceBodyMapping, ResourceBodySpecialResult } from "./resourceBody";
import { appendGeneratedPath, joinGeneratedPath } from "./sourcePaths";

const paletteKeyField = "palette_key";

export interface RsglAtlasSugarOptions {
  onError?: (code: string, message: string, range: TextRange) => void;
}

export type AtlasBodyCompiler = (
  body: ResourceBodyNode,
  context: EvaluationContext
) => { content: Record<string, JsonValue>; mappings: ResourceBodyMapping[] };

export function compileAtlasSpecialStatement(
  statement: ResourceStatementNode,
  context: EvaluationContext,
  compileBody: AtlasBodyCompiler,
  options: RsglAtlasSugarOptions = {}
): ResourceBodySpecialResult | undefined {
  if (statement.kind === "AtlasDirectoryStmt") {
    return compileAtlasDirectoryStatement(statement, context, options);
  }
  if (statement.kind === "AtlasFilterStmt") {
    return compileAtlasFilterStatement(statement, context, options);
  }
  if (statement.kind === "AtlasPalettedPermutationsStmt") {
    return compileAtlasPalettedPermutationsStatement(statement, context, compileBody, options);
  }
  return undefined;
}

function compileAtlasDirectoryStatement(
  statement: AtlasDirectoryStmtNode,
  context: EvaluationContext,
  options: RsglAtlasSugarOptions
): Record<string, JsonValue> | undefined {
  const source = statement.source ? staticText(statement.source, context) : null;
  const prefix = statement.prefix ? staticText(statement.prefix, context) : null;
  if (!source) {
    options.onError?.("rsgl.invalidAtlasDirectorySource", "Atlas directory source requires a static source string.", statement.range);
    return undefined;
  }
  if (statement.prefix && prefix === null) {
    options.onError?.("rsgl.invalidAtlasDirectoryPrefix", "Atlas directory prefix must be a static string.", statement.prefix.range);
    return undefined;
  }
  const entry: Record<string, JsonValue> = {
    type: "minecraft:directory",
    source
  };
  if (prefix !== null) {
    entry.prefix = prefix;
  }
  return { sources: [entry] };
}

function compileAtlasFilterStatement(
  statement: AtlasFilterStmtNode,
  context: EvaluationContext,
  options: RsglAtlasSugarOptions
): Record<string, JsonValue> | undefined {
  const namespace = statement.namespace ? staticText(statement.namespace, context) : null;
  const path = statement.path ? staticText(statement.path, context) : null;
  if (!namespace || !path) {
    options.onError?.("rsgl.invalidAtlasFilter", "Atlas filter requires static namespace and path patterns.", statement.range);
    return undefined;
  }
  return {
    sources: [{
      type: "minecraft:filter",
      pattern: {
        namespace,
        path
      }
    }]
  };
}

function compileAtlasPalettedPermutationsStatement(
  statement: AtlasPalettedPermutationsStmtNode,
  context: EvaluationContext,
  compileBody: AtlasBodyCompiler,
  options: RsglAtlasSugarOptions
): ResourceBodyFragment | undefined {
  const body = compileBody(statement.body, context);
  const textures = atlasTextureList(body.content.textures);
  const paletteKey = typeof body.content.palette_key === "string" ? body.content.palette_key : null;
  const permutations = jsonObject(body.content.permutations);

  if (!textures) {
    options.onError?.("rsgl.invalidAtlasPalettedPermutations", "Atlas paletted_permutations requires textures to be a string or list of strings.", statement.range);
    return undefined;
  }
  if (!paletteKey) {
    options.onError?.("rsgl.invalidAtlasPalettedPermutations", "Atlas paletted_permutations requires a static palette_key string.", statement.range);
    return undefined;
  }
  if (!permutations) {
    options.onError?.("rsgl.invalidAtlasPalettedPermutations", "Atlas paletted_permutations requires permutations to be an object.", statement.range);
    return undefined;
  }

  const content = {
    sources: [{
      ...body.content,
      type: "minecraft:paletted_permutations",
      textures,
      [paletteKeyField]: paletteKey,
      permutations
    }]
  };
  return {
    content,
    mappings: atlasSourceMappings(statement, context, body.mappings)
  };
}

function atlasSourceMappings(
  statement: AtlasPalettedPermutationsStmtNode,
  context: EvaluationContext,
  mappings: ResourceBodyMapping[]
): ResourceBodyMapping[] {
  const sourcePath = appendGeneratedPath("/sources", "0");
  return [
    {
      generatedPath: sourcePath,
      sourceRange: statement.range,
      context
    },
    ...mappings.map(mapping => ({
      ...mapping,
      generatedPath: joinGeneratedPath(sourcePath, mapping.generatedPath)
    }))
  ];
}

function atlasTextureList(value: JsonValue | undefined): string[] | null {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every(item => typeof item === "string")) {
    return value;
  }
  return null;
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

function staticText(expression: ExprNode, context: EvaluationContext): string | null {
  const value = evaluateExpression(expression, context);
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}
