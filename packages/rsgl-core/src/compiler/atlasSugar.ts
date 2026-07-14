import {
  AtlasDirectoryStmtNode,
  AtlasFilterStmtNode,
  AtlasPalettedPermutationsStmtNode,
  ExprNode,
  ResourceBodyNode,
  ResourceStatementNode
} from "../parser";
import { EvaluationContext, type EvaluationResult } from "./evaluate";
import { evaluatedPathOrigins } from "./evaluationProvenance";
import { JsonValue } from "./ir";
import { evaluateJsonExpressionWithResult, type JsonValueSinkOptions } from "./jsonValueLowerer";
import { ResourceBodyFragment, ResourceBodyMapping, ResourceBodySpecialResult } from "./resourceBody";
import { appendGeneratedPath } from "./sourcePaths";

const paletteKeyField = "palette_key";

export type RsglAtlasSugarOptions = JsonValueSinkOptions;

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
): ResourceBodyFragment | undefined {
  const evaluatedSource = statement.source
    ? staticText(statement.source, context, options, "/sources/0/source")
    : null;
  const evaluatedPrefix = statement.prefix
    ? staticText(statement.prefix, context, options, "/sources/0/prefix")
    : null;
  if (!evaluatedSource?.value) {
    options.onError?.("rsgl.invalidAtlasDirectorySource", "Atlas directory source requires a static source string.", statement.range);
    return undefined;
  }
  if (statement.prefix && evaluatedPrefix === null) {
    options.onError?.("rsgl.invalidAtlasDirectoryPrefix", "Atlas directory prefix must be a static string.", statement.prefix.range);
    return undefined;
  }
  const entry: Record<string, JsonValue> = {
    type: "minecraft:directory",
    source: evaluatedSource.value
  };
  if (evaluatedPrefix !== null) {
    entry.prefix = evaluatedPrefix.value;
  }
  return {
    content: { sources: [entry] },
    mappings: statement.source
      ? evaluatedPathOrigins(
        evaluatedSource.result,
        context.sourceFile,
        "/sources/0/source"
      ).map(origin => ({
        generatedPath: origin.generatedPath,
        sourceRange: statement.source!.range,
        context,
        validationOrigin: origin,
        validationOnly: true
      }))
      : []
  };
}

function compileAtlasFilterStatement(
  statement: AtlasFilterStmtNode,
  context: EvaluationContext,
  options: RsglAtlasSugarOptions
): Record<string, JsonValue> | undefined {
  const evaluatedNamespace = statement.namespace
    ? staticText(statement.namespace, context, options, "/sources/0/pattern/namespace")
    : null;
  const evaluatedPath = statement.path
    ? staticText(statement.path, context, options, "/sources/0/pattern/path")
    : null;
  if (!evaluatedNamespace?.value || !evaluatedPath?.value) {
    options.onError?.("rsgl.invalidAtlasFilter", "Atlas filter requires static namespace and path patterns.", statement.range);
    return undefined;
  }
  return {
    sources: [{
      type: "minecraft:filter",
      pattern: {
        namespace: evaluatedNamespace.value,
        path: evaluatedPath.value
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
    ...mappings
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

function staticText(
  expression: ExprNode,
  context: EvaluationContext,
  options: RsglAtlasSugarOptions,
  generatedPath: string
): { value: string; result: EvaluationResult } | null {
  const evaluated = evaluateJsonExpressionWithResult(expression, context, options, generatedPath);
  if (!evaluated) {
    return null;
  }
  const { value } = evaluated;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? { value: String(value), result: evaluated.result }
    : null;
}
