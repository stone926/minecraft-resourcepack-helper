import { isValidMinecraftNamespace } from "../../../mc-assets/src";
import { ExprNode, ResourceDeclNode } from "../parser";
import {
  getRsglResourceKindDescriptor,
  isRsglGenericJsonResourceKind,
  RsglResourceCompileHandler,
  type RsglResourceKind
} from "../resourceKinds";
import {
  compactEquipmentSourceMappings,
  copyResourceTarget,
  copySourcePath,
  isExistingFile,
  isPackRelativeTargetExpression,
  jsonResourceTarget,
  normalizeJsonValue,
  normalizeMcmetaOutputPath,
  textContent,
  textResourceTarget
} from "./compilerHelpers";
import { lowerEquipmentBodySugar } from "./equipmentSugar";
import { EvaluationContext, type EvaluationResult } from "./evaluate";
import { evaluatedOriginAtPath } from "./evaluationProvenance";
import { evaluationScalarText } from "./evaluatedResourceValues";
import { BinaryCopyRef, JsonValue, ResourceUnit, RsglMapping } from "./ir";
import { JsonResourceFragmentKind } from "./jsonResourceFragments";
import { applyModelImpl } from "./modelImpl";
import { ResourceBodyMapping } from "./resourceBody";
import { parseResourceId, resourceOutputPath } from "./resourceIds";
import { applyResourceKindOutputPath } from "./resourceKindOutput";
import { RsglCompileContext } from "./templateExpansion";

type SourceRange = { start: number; end: number };

export interface ResourceDeclarationCompilerHost {
  fileName: string;
  compileBlockstate: (statement: ResourceDeclNode, context: RsglCompileContext) => ResourceUnit | null;
  compilePack: (statement: ResourceDeclNode, context: RsglCompileContext) => ResourceUnit | null;
  compileBody: (
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    resourceKind: Exclude<RsglResourceKind, "blockstate" | "pack">
  ) => { content: Record<string, JsonValue>; mappings: RsglMapping[] };
  compileJsonBody: (
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    fragmentKind: JsonResourceFragmentKind
  ) => { content: Record<string, JsonValue>; mappings: RsglMapping[] };
  compileRawBody: (
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    resourceKind: "text" | "copy"
  ) => { content: Record<string, JsonValue>; mappings: ResourceBodyMapping[] };
  onError: (code: string, message: string, range: SourceRange) => void;
  sourceMap: (
    outputPath: string,
    node: { range: SourceRange },
    context: RsglCompileContext,
    mappings?: RsglMapping[]
  ) => ResourceUnit["sourceMap"];
  sourceMapping: (generatedPath: string, sourceRange: SourceRange, context: EvaluationContext) => RsglMapping;
  evaluateResult: (expression: ExprNode, context: EvaluationContext) => EvaluationResult;
}

type ResourceCompileHandler = (
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
) => ResourceUnit | ResourceUnit[] | null;

const resourceCompileHandlers = {
  model: compileModel,
  blockstate: (statement, context, host) => host.compileBlockstate(statement, context),
  item: compileItem,
  genericJson: compileGenericJsonResource,
  mcmeta: compileMcmeta,
  arbitraryJson: compileArbitraryJsonResource,
  pack: (statement, context, host) => host.compilePack(statement, context),
  lang: compileLang,
  sounds: compileSounds,
  text: compileTextResource,
  copy: compileCopyResource
} satisfies Record<RsglResourceCompileHandler, ResourceCompileHandler>;

export function compileResourceDeclaration(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
): ResourceUnit[] {
  const descriptor = getRsglResourceKindDescriptor(statement.resourceKind);
  if (!descriptor) {
    return [];
  }
  const result = resourceCompileHandlers[descriptor.compile.handler](statement, context, host);
  const units = descriptor.compile.cardinality === "many"
    ? result as ResourceUnit[]
    : result ? [result as ResourceUnit] : [];
  return units.map(unit => applyResourceKindOutputPath(statement.resourceKind, unit));
}

function compileModel(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
): ResourceUnit | null {
  const idValue = statement.id ? staticResourceText(statement.id, context, host) : null;
  if (!idValue) {
    host.onError("rsgl.compileMissingResourceId", "Model declaration requires a static id.", statement.range);
    return null;
  }
  const subtype = statement.subtype?.text ?? "block";
  const id = parseResourceId(idValue, context.namespace);
  if (!id) {
    host.onError("rsgl.compileInvalidResourceId", `Invalid model id '${idValue}'.`, statement.id?.range ?? statement.range);
    return null;
  }
  const modelId = { namespace: id.namespace, path: `${subtype}/${id.path}` };
  const outputPath = resourceOutputPath("model", modelId);
  const body = host.compileBody(statement.body, context, "model");
  const { content, mappings } = applyModelImpl(statement, subtype, body, context, {
    onError: host.onError,
    createMapping: (generatedPath, sourceRange, validationOrigin) => ({
      ...host.sourceMapping(generatedPath, sourceRange, context),
      ...(validationOrigin ? { validationOrigin } : {})
    })
  });
  return {
    id: modelId,
    kind: "model",
    outputPath,
    content,
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: host.sourceMap(outputPath, statement, context, mappings)
  };
}

function compileItem(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
): ResourceUnit | null {
  const idValue = statement.id ? staticResourceText(statement.id, context, host) : null;
  const id = idValue ? parseResourceId(idValue, context.namespace) : null;
  if (!id || !statement.id) {
    host.onError("rsgl.compileMissingResourceId", "Item declaration requires a static id.", statement.range);
    return null;
  }
  const body = host.compileBody(statement.body, context, "item");
  const model = typeof body.content.model === "string"
    ? { type: "minecraft:model", model: body.content.model }
    : body.content.model;
  const outputPath = resourceOutputPath("item", id);
  return {
    id,
    kind: "item",
    outputPath,
    content: { ...body.content, model: normalizeJsonValue(model) },
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: host.sourceMap(outputPath, statement, context, body.mappings)
  };
}

function compileGenericJsonResource(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
): ResourceUnit | null {
  const resourceKind = statement.resourceKind;
  if (!isRsglGenericJsonResourceKind(resourceKind)) {
    host.onError("rsgl.invalidGenericJsonResource", `${resourceKind} is not a generic JSON resource kind.`, statement.range);
    return null;
  }
  const idValue = statement.id ? staticResourceText(statement.id, context, host) : null;
  const id = idValue ? parseResourceId(idValue, context.namespace) : null;
  if (!id || !statement.id) {
    host.onError("rsgl.compileMissingResourceId", `${resourceKind} declaration requires a static id.`, statement.range);
    return null;
  }
  const outputPath = resourceOutputPath(resourceKind, id);
  const body = host.compileJsonBody(statement.body, context, resourceKind);
  let content = body.content;
  let mappings = body.mappings;
  if (resourceKind === "equipment") {
    const equipmentBody = lowerEquipmentBodySugar(content, context, statement.range, { onError: host.onError });
    content = equipmentBody.content;
    mappings = equipmentBody.compactLayers
      ? compactEquipmentSourceMappings(mappings, content)
      : mappings;
  }
  return {
    id,
    kind: resourceKind,
    outputPath,
    content,
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: host.sourceMap(outputPath, statement, context, mappings)
  };
}

function compileArbitraryJsonResource(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
): ResourceUnit | null {
  const targetValue = statement.id ? staticResourceText(statement.id, context, host) : null;
  if (!targetValue || !statement.id) {
    host.onError("rsgl.compileMissingResourceId", "JSON declaration requires a static resource id or pack-relative path.", statement.range);
    return null;
  }
  const target = jsonResourceTarget(targetValue, context.namespace, isPackRelativeTargetExpression(statement.id));
  if (!target) {
    host.onError("rsgl.compileInvalidJsonTarget", `Invalid JSON resource target '${targetValue}'.`, statement.id.range);
    return null;
  }
  const body = host.compileBody(statement.body, context, "json");
  return {
    id: target.id,
    kind: "json",
    outputPath: target.outputPath,
    content: body.content,
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: host.sourceMap(target.outputPath, statement, context, body.mappings)
  };
}

function compileLang(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
): ResourceUnit | null {
  const idValue = statement.id ? staticResourceText(statement.id, context, host) : null;
  const id = idValue ? parseResourceId(idValue, context.namespace) : null;
  if (!id || !statement.id) {
    host.onError("rsgl.compileMissingResourceId", "Lang declaration requires a static locale id.", statement.range);
    return null;
  }
  const outputPath = resourceOutputPath("lang", id);
  const body = host.compileBody(statement.body, context, "lang");
  return {
    id,
    kind: "lang",
    outputPath,
    content: body.content,
    mergePolicy: { kind: "mergeObject" },
    sourceMap: host.sourceMap(outputPath, statement, context, body.mappings)
  };
}

function compileSounds(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
): ResourceUnit | null {
  const namespace = soundsNamespace(statement, context, host);
  if (!namespace) {
    host.onError("rsgl.compileMissingResourceId", "Sounds declaration requires a namespace.", statement.range);
    return null;
  }
  const id = { namespace, path: "sounds" };
  const outputPath = `assets/${namespace}/sounds.json`;
  const body = host.compileBody(statement.body, context, "sounds");
  return {
    id,
    kind: "sounds",
    outputPath,
    content: body.content,
    mergePolicy: { kind: "mergeObject" },
    sourceMap: host.sourceMap(outputPath, statement, context, body.mappings)
  };
}

function compileTextResource(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
): ResourceUnit | null {
  const targetValue = statement.id ? staticResourceText(statement.id, context, host) : null;
  if (!targetValue || !statement.id) {
    host.onError("rsgl.compileMissingResourceId", "Text declaration requires a static resource id or pack-relative path.", statement.range);
    return null;
  }
  const target = textResourceTarget(targetValue, context.namespace);
  if (!target) {
    host.onError("rsgl.compileInvalidTextTarget", `Invalid text resource target '${targetValue}'.`, statement.id.range);
    return null;
  }
  const body = host.compileRawBody(statement.body, context, "text");
  for (const key of Object.keys(body.content)) {
    if (key !== "content") {
      host.onError("rsgl.invalidTextResourceField", `Text resources do not support field '${key}'.`, statement.body.range);
    }
  }
  const text = textContent(body.content.content);
  if (text === null) {
    host.onError("rsgl.invalidTextContent", "Text resource requires a scalar 'content' field.", statement.body.range);
    return null;
  }
  const mappings = body.mappings
    .filter(mapping => mapping.generatedPath === "/content")
    .map(mapping => host.sourceMapping("", mapping.sourceRange, mapping.context));
  return {
    id: target.id,
    kind: "text",
    outputPath: target.outputPath,
    content: { kind: "text", text },
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: host.sourceMap(target.outputPath, statement, context, mappings)
  };
}

function compileCopyResource(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
): ResourceUnit | null {
  const targetValue = statement.id ? staticResourceText(statement.id, context, host) : null;
  if (!targetValue || !statement.id) {
    host.onError("rsgl.compileMissingResourceId", "Copy declaration requires a static resource id or pack-relative path.", statement.range);
    return null;
  }
  const target = copyResourceTarget(targetValue, context.namespace, isPackRelativeTargetExpression(statement.id));
  if (!target) {
    host.onError("rsgl.compileInvalidCopyTarget", `Invalid copy resource target '${targetValue}'.`, statement.id.range);
    return null;
  }
  const body = host.compileRawBody(statement.body, context, "copy");
  for (const key of Object.keys(body.content)) {
    if (key !== "from") {
      host.onError("rsgl.invalidCopyResourceField", `Copy resources do not support field '${key}'.`, statement.body.range);
    }
  }
  const sourcePath = copySourcePath(body.content.from, context.sourceFile ?? host.fileName);
  if (!sourcePath) {
    host.onError("rsgl.invalidCopySource", "Copy resource requires a static string 'from' field.", statement.body.range);
    return null;
  }
  if (!isExistingFile(sourcePath)) {
    host.onError("rsgl.copySourceNotFound", `Copy source file not found: ${sourcePath}`, statement.body.range);
    return null;
  }
  const mappings = body.mappings
    .filter(mapping => mapping.generatedPath === "/from")
    .map(mapping => host.sourceMapping("", mapping.sourceRange, mapping.context));
  const content: BinaryCopyRef = { kind: "copy", sourcePath };
  return {
    id: target.id,
    kind: "copy",
    outputPath: target.outputPath,
    content,
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: host.sourceMap(target.outputPath, statement, context, mappings)
  };
}

function compileMcmeta(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
): ResourceUnit[] {
  const targetEvaluation = mcmetaTargetValues(statement, context, host);
  if (!targetEvaluation) {
    return [];
  }
  const body = host.compileJsonBody(statement.body, context, "mcmeta");
  const units: ResourceUnit[] = [];
  for (const targetValue of targetEvaluation.targets) {
    const target = mcmetaTarget(targetValue.value, context.namespace);
    if (!target) {
      host.onError("rsgl.compileInvalidResourceId", `Invalid mcmeta target '${targetValue.value}'.`, statement.id?.range ?? statement.range);
      continue;
    }
    const validationOrigin = evaluatedOriginAtPath(
      targetEvaluation.result,
      context.sourceFile,
      targetValue.selectedPath
    );
    const resourceIdMappings: RsglMapping[] = statement.id && validationOrigin
      ? [{
          ...host.sourceMapping("/@resource-id", statement.id.range, context),
          validationOrigin,
          validationOnly: true
        }]
      : [];
    units.push({
      id: target.id,
      kind: "mcmeta",
      outputPath: target.outputPath,
      content: body.content,
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: host.sourceMap(
        target.outputPath,
        statement,
        context,
        [...body.mappings, ...resourceIdMappings]
      )
    });
  }
  return units;
}

function mcmetaTargetValues(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
): {
  result: EvaluationResult;
  targets: Array<{ value: string; selectedPath: string }>;
} | null {
  if (!statement.id) {
    host.onError("rsgl.compileMissingResourceId", "Mcmeta declaration requires a static target path.", statement.range);
    return null;
  }
  const result = host.evaluateResult(statement.id, context);
  const value = result.value;
  if (Array.isArray(value)) {
    const targets: Array<{ value: string; selectedPath: string }> = [];
    for (const [index, item] of value.entries()) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        targets.push({ value: String(item), selectedPath: `/${index}` });
      } else {
        host.onError("rsgl.compileInvalidResourceId", "Mcmeta glob results must be static path strings.", statement.id.range);
      }
    }
    if (targets.length === 0) {
      host.onError("rsgl.mcmetaGlobNoMatches", "mcmeta glob did not match any target PNG files.", statement.id.range);
    }
    return { result, targets };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { result, targets: [{ value: String(value), selectedPath: "" }] };
  }
  host.onError("rsgl.compileMissingResourceId", "Mcmeta declaration requires a static target path.", statement.range);
  return null;
}

function soundsNamespace(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  host: ResourceDeclarationCompilerHost
): string | null {
  const idValue = statement.id ? staticResourceText(statement.id, context, host) : null;
  if (!idValue) {
    return null;
  }
  if (isValidMinecraftNamespace(idValue)) {
    return idValue;
  }
  return parseResourceId(idValue, context.namespace)?.namespace ?? null;
}

function staticResourceText(
  expression: ExprNode,
  context: EvaluationContext,
  host: ResourceDeclarationCompilerHost
): string | null {
  return evaluationScalarText(host.evaluateResult(expression, context).value);
}

function mcmetaTarget(value: string, namespace: string): { id?: { namespace: string; path: string }; outputPath: string } | null {
  const normalizedPath = value.replace(/\\/g, "/");
  if (normalizedPath.startsWith("assets/")) {
    return { outputPath: normalizeMcmetaOutputPath(normalizedPath) };
  }
  const id = parseResourceId(value, namespace);
  if (!id) {
    return null;
  }
  const texturePath = id.path.startsWith("textures/") ? id.path.slice("textures/".length) : id.path;
  const pngPath = texturePath.endsWith(".png") || texturePath.endsWith(".png.mcmeta")
    ? texturePath
    : `${texturePath}.png`;
  return {
    id,
    outputPath: normalizeMcmetaOutputPath(`assets/${id.namespace}/textures/${pngPath}`)
  };
}
