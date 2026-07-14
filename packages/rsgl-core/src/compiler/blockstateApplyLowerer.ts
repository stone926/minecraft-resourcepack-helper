import type {
  BlockstateApplyExprNode,
  BlockstateApplyValueNode,
  BlockstateModelPropertyNode,
  BlockstateRandomItemNode,
  ExprNode,
  TextRange
} from "../parser";
import type {
  RsglBlockstateApplyFact,
  RsglBlockstateApplySiteNode
} from "../semantic";
import {
  isEvaluatedResourceId,
  type RsglResourceValueObservation
} from "./evaluatedResourceValues";
import {
  evaluateExpressionResult,
  type EvaluationOrigin,
  type EvaluationResult,
  originForEvaluationPath,
  rangeForEvaluationPath,
  type EvaluationValue
} from "./evaluate";
import type { JsonValue } from "./ir";
import { cloneJsonValue, isJsonObject } from "./jsonValues";
import {
  createJsonValueLoweringHost,
  type JsonValueSinkOptions,
  lowerJsonEvaluationResult
} from "./jsonValueLowerer";
import { parseResourceId, resourceIdToString } from "./resourceIds";
import { appendGeneratedPath, joinGeneratedPath } from "./sourcePaths";
import type { RsglCompileContext } from "./templateExpansion";

export interface BlockstateApplyLoweringHost extends JsonValueSinkOptions {
  onError: NonNullable<JsonValueSinkOptions["onError"]>;
  getApplyFact?: (node: RsglBlockstateApplySiteNode) => RsglBlockstateApplyFact | undefined;
}

/** Mapping path is relative to the variant value or multipart `apply` object. */
export interface BlockstateLoweredMapping {
  readonly generatedPath: string;
  readonly sourceRange: TextRange;
  readonly origin?: EvaluationOrigin;
}

export interface LoweredBlockstateApply {
  readonly value: JsonValue;
  readonly mappings: readonly BlockstateLoweredMapping[];
  /** Resource values at paths relative to this variant value or multipart apply. */
  readonly resourceValueObservations: readonly RsglResourceValueObservation[];
}

interface LoweredBlockstateApplyCore {
  readonly value: JsonValue;
  readonly mappings: readonly BlockstateLoweredMapping[];
}

/** Canonical model/apply lowering; each head and property expression is evaluated once. */
export function lowerBlockstateApply(
  value: BlockstateApplyValueNode,
  context: RsglCompileContext,
  host: BlockstateApplyLoweringHost
): LoweredBlockstateApply | undefined {
  return captureApplyResourceValues(host, loweringHost =>
    lowerBlockstateApplyCore(value, context, loweringHost)
  );
}

function lowerBlockstateApplyCore(
  value: BlockstateApplyValueNode,
  context: RsglCompileContext,
  host: BlockstateApplyLoweringHost
): LoweredBlockstateApplyCore | undefined {
  if (value.kind === "BlockstateRandomValue") {
    if (value.items.length === 0) {
      host.onError(
        "rsgl.emptyBlockstateRandom",
        "A blockstate random value must contain at least one model.",
        value.range
      );
      return undefined;
    }
    const entries: JsonValue[] = [];
    const mappings: BlockstateLoweredMapping[] = [mapping("", value.range)];
    for (const [index, item] of value.items.entries()) {
      const itemPath = appendGeneratedPath("", String(index));
      const lowered = lowerRandomItem(
        item,
        context,
        withResourceValuePathPrefix(host, itemPath)
      );
      if (!lowered) {
        return undefined;
      }
      entries.push(lowered.value);
      mappings.push(mapping(itemPath, item.range));
      mappings.push(...lowered.mappings.map(itemMapping => ({
        ...itemMapping,
        generatedPath: joinGeneratedPath(itemPath, itemMapping.generatedPath)
      })));
    }
    return { value: entries, mappings: deduplicateMappings(mappings) };
  }
  return lowerApplyExpression(value, context, host, true, value);
}

function lowerRandomItem(
  item: BlockstateRandomItemNode,
  context: RsglCompileContext,
  host: BlockstateApplyLoweringHost
): LoweredBlockstateApplyCore | undefined {
  return lowerApplyExpression(item, context, host, false, item);
}

function lowerApplyExpression(
  expression: Pick<BlockstateApplyExprNode, "range" | "head" | "properties">,
  context: RsglCompileContext,
  host: BlockstateApplyLoweringHost,
  allowList: boolean,
  factNode: RsglBlockstateApplySiteNode
): LoweredBlockstateApplyCore | undefined {
  const fact = host.getApplyFact?.(factNode);
  const headResult = evaluateBlockstateExpressionResult(expression.head, context);
  if (!headResult) {
    return undefined;
  }
  const serialHead = lowerBlockstateJsonValue(
    headResult,
    expression.head.range,
    context,
    host,
    expression.properties.length > 0 || isEvaluatedResourceId(headResult.value)
      ? "/model"
      : ""
  );
  if (serialHead === undefined) {
    return undefined;
  }
  let lowered: JsonValue;
  let mappings: BlockstateLoweredMapping[];
  if (expression.properties.length > 0) {
    const model = canonicalModelId(serialHead, context, expression.head.range, host);
    if (!model) {
      if (typeof serialHead !== "string") {
        host.onError(
          "rsgl.invalidBlockstateApplyHead",
          "A blockstate apply value with trailing properties must start with a ModelId.",
          expression.head.range
        );
      }
      return undefined;
    }
    lowered = { model };
    mappings = [
      mapping("", expression.range),
      mapping(
        "/model",
        rangeForEvaluationPath(headResult.pathRanges, "") ?? expression.head.range,
        originForEvaluationPath(headResult.pathOrigins, "") ?? headResult.origin
      )
    ];
  } else {
    const modelValue = lowerModelValue(
      serialHead,
      context,
      expression.head.range,
      host,
      allowList,
      fact?.unknownFields === "preserveExplicitJson",
      isStaticallyClosedModelType(fact),
      headResult
    );
    if (modelValue === undefined) {
      return undefined;
    }
    lowered = modelValue;
    mappings = collectValueMappings(modelValue, expression.head.range, headResult);
  }

  if (!isJsonObject(lowered)) {
    if (expression.properties.length > 0) {
      return undefined;
    }
    return { value: lowered, mappings: deduplicateMappings(mappings) };
  }
  if (!applyModelProperties(lowered, expression.properties, context, host, mappings)) {
    return undefined;
  }
  const withoutDefaults = expression.properties.length > 0
    ? omitBlockstateModelDefaults(lowered)
    : lowered;
  return {
    value: withoutDefaults,
    mappings: deduplicateMappings(mappings.filter(item =>
      mappingPathExists(item.generatedPath, withoutDefaults)
    ))
  };
}

function lowerModelValue(
  value: EvaluationValue,
  context: RsglCompileContext,
  range: TextRange,
  host: BlockstateApplyLoweringHost,
  allowList: boolean,
  preserveUnknownFields: boolean,
  suppressRuntimeUnknownFieldDiagnostic: boolean,
  evaluation: EvaluationResult
): JsonValue | undefined {
  if (typeof value === "string") {
    const model = canonicalModelId(value, context, range, host);
    return model ? { model } : undefined;
  }
  const model = canonicalModelId(value, context, range, host);
  if (model) {
    return { model };
  }
  if (Array.isArray(value)) {
    if (!allowList) {
      host.onError(
        "rsgl.nestedBlockstateModelList",
        "A blockstate random item cannot contain a model list.",
        range
      );
      return undefined;
    }
    if (value.length === 0) {
      host.onError(
        "rsgl.emptyBlockstateModelList",
        "A blockstate model list must contain at least one model object.",
        range
      );
      return undefined;
    }
    const result: JsonValue[] = [];
    for (const [index, item] of value.entries()) {
      if (Array.isArray(item)) {
        host.onError(
          "rsgl.nestedBlockstateModelList",
          "Blockstate model lists must be flat.",
          range
        );
        return undefined;
      }
      const object = lowerModelObject(
        item,
        context,
        rangeForEvaluationPath(evaluation.pathRanges, `/${index}`) ?? range,
        host,
        preserveUnknownFields,
        suppressRuntimeUnknownFieldDiagnostic,
        evaluation,
        `/${index}`
      );
      if (!object) {
        return undefined;
      }
      result.push(object);
    }
    return result;
  }
  return lowerModelObject(
    value,
    context,
    range,
    host,
    preserveUnknownFields,
    suppressRuntimeUnknownFieldDiagnostic,
    evaluation,
    ""
  );
}

function lowerModelObject(
  value: EvaluationValue,
  context: RsglCompileContext,
  range: TextRange,
  host: BlockstateApplyLoweringHost,
  preserveUnknownFields: boolean,
  suppressRuntimeUnknownFieldDiagnostic: boolean,
  evaluation: EvaluationResult,
  basePath: string
): Record<string, JsonValue> | undefined {
  const objectLocation = evaluationLocation(evaluation, basePath, range);
  if (!isJsonObject(value)) {
    host.onError(
      "rsgl.missingBlockstateModel",
      "A blockstate model object must contain a ModelId in its 'model' field.",
      objectLocation.range,
      objectLocation.fileName
    );
    return undefined;
  }
  const modelLocation = evaluationLocation(
    evaluation,
    appendGeneratedPath(basePath, "model"),
    objectLocation.range
  );
  const model = canonicalModelId(
    value.model,
    context,
    modelLocation.range,
    host,
    modelLocation.fileName
  );
  if (!model) {
    host.onError(
      "rsgl.missingBlockstateModel",
      "A blockstate model object must contain a valid ModelId in its 'model' field.",
      modelLocation.range,
      modelLocation.fileName
    );
    return undefined;
  }
  const result = cloneJsonValue(value) as Record<string, JsonValue>;
  result.model = model;
  if (!validateKnownModelFields(
    result,
    objectLocation.range,
    host,
    preserveUnknownFields,
    suppressRuntimeUnknownFieldDiagnostic,
    evaluation,
    basePath
  )) {
    return undefined;
  }
  return result;
}

function canonicalModelId(
  value: EvaluationValue,
  context: RsglCompileContext,
  range: TextRange,
  host: BlockstateApplyLoweringHost,
  fileName?: string
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const id = parseResourceId(value, context.namespace);
  if (!id) {
    host.onError(
      "rsgl.invalidBlockstateModelId",
      `Invalid blockstate model id '${value}'.`,
      range,
      fileName
    );
    return undefined;
  }
  return resourceIdToString(id);
}

function applyModelProperties(
  target: Record<string, JsonValue>,
  properties: readonly BlockstateModelPropertyNode[],
  context: RsglCompileContext,
  host: BlockstateApplyLoweringHost,
  mappings: BlockstateLoweredMapping[]
): boolean {
  const seen = new Set<string>();
  for (const property of properties) {
    const name = property.name.text;
    if (!knownModelFields.has(name)) {
      host.onError(
        "rsgl.unknownBlockstateModelField",
        `Unknown blockstate model field '${name}'.`,
        property.name.range
      );
      return false;
    }
    if (seen.has(name)) {
      host.onError(
        "rsgl.duplicateBlockstateModelField",
        `Blockstate model field '${name}' is specified more than once.`,
        property.name.range
      );
      return false;
    }
    seen.add(name);
    const result = evaluateBlockstateExpressionResult(property.value, context);
    if (!result) {
      return false;
    }
    const location = evaluationLocation(result, "", property.value.range);
    const value = lowerBlockstateJsonValue(
      result,
      location.range,
      context,
      host,
      appendGeneratedPath("", name)
    );
    if (value === undefined) {
      return false;
    }
    target[name] = value;
    mappings.push(mapping(
      appendGeneratedPath("", name),
      rangeForEvaluationPath(result.pathRanges, "") ?? property.value.range,
      originForEvaluationPath(result.pathOrigins, "") ?? result.origin
    ));
  }
  return true;
}

function evaluateBlockstateExpressionResult(
  expression: ExprNode,
  context: RsglCompileContext
): EvaluationResult | undefined {
  let evaluationFailed = false;
  const result = evaluateExpressionResult(expression, {
    ...context,
    onEvaluationFailure: () => {
      evaluationFailed = true;
      context.onEvaluationFailure?.();
    }
  });
  return evaluationFailed ? undefined : result;
}

function validateKnownModelFields(
  value: Record<string, JsonValue>,
  range: TextRange,
  host: BlockstateApplyLoweringHost,
  preserveUnknownFields: boolean,
  suppressRuntimeUnknownFieldDiagnostic: boolean,
  evaluation: EvaluationResult,
  basePath: string
): boolean {
  for (const name of Object.keys(value)) {
    if (name === "model") {
      continue;
    }
    const location = evaluationLocation(
      evaluation,
      appendGeneratedPath(basePath, name),
      range
    );
    if (!knownModelFields.has(name)) {
      if (preserveUnknownFields) {
        continue;
      }
      if (!suppressRuntimeUnknownFieldDiagnostic) {
        host.onError(
          "rsgl.unknownBlockstateModelField",
          `Unknown blockstate model field '${name}'.`,
          location.range,
          location.fileName
        );
      }
      return false;
    }
  }
  return true;
}

function isStaticallyClosedModelType(fact: RsglBlockstateApplyFact | undefined): boolean {
  const type = fact?.actualType;
  const isClosed = (candidate: RsglBlockstateApplyFact["actualType"]): boolean =>
    candidate.kind === "Object"
    || candidate.kind === "BlockstateModelObject"
    || Boolean(candidate.kind === "List" && candidate.elementType && isClosed(candidate.elementType));
  return type ? isClosed(type) : false;
}

function evaluationLocation(
  result: EvaluationResult,
  generatedPath: string,
  fallbackRange: TextRange
): { range: TextRange; fileName?: string } {
  const origin = originForEvaluationPath(result.pathOrigins, generatedPath);
  if (origin) {
    return { range: origin.sourceRange, fileName: origin.sourceFile };
  }
  return {
    range: rangeForEvaluationPath(result.pathRanges, generatedPath) ?? fallbackRange
  };
}

function omitBlockstateModelDefaults(value: Record<string, JsonValue>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === "x" || key === "y" || key === "z") && item === 0) {
      continue;
    }
    if (key === "uvlock" && item === false) {
      continue;
    }
    if (key === "weight" && item === 1) {
      continue;
    }
    result[key] = item;
  }
  return result;
}

function collectValueMappings(
  value: JsonValue,
  fallbackRange: TextRange,
  result: EvaluationResult,
  generatedPath = ""
): BlockstateLoweredMapping[] {
  const mappings = [mapping(
    generatedPath,
    rangeForEvaluationPath(result.pathRanges, generatedPath) ?? fallbackRange,
    originForEvaluationPath(result.pathOrigins, generatedPath)
  )];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      mappings.push(...collectValueMappings(
        item,
        fallbackRange,
        result,
        appendGeneratedPath(generatedPath, String(index))
      ));
    });
  } else if (isJsonObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      mappings.push(...collectValueMappings(
        item,
        fallbackRange,
        result,
        appendGeneratedPath(generatedPath, key)
      ));
    }
  }
  return mappings;
}

function mapping(
  generatedPath: string,
  sourceRange: TextRange,
  origin?: EvaluationOrigin
): BlockstateLoweredMapping {
  return { generatedPath, sourceRange, ...(origin ? { origin } : {}) };
}

function deduplicateMappings(mappings: readonly BlockstateLoweredMapping[]): BlockstateLoweredMapping[] {
  const byPath = new Map<string, BlockstateLoweredMapping>();
  mappings.forEach(item => byPath.set(item.generatedPath, item));
  return [...byPath.values()];
}

function mappingPathExists(path: string, value: JsonValue): boolean {
  if (!path) {
    return true;
  }
  let current = value;
  for (const encodedSegment of path.split("/").slice(1)) {
    const segment = encodedSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment) || Number(segment) >= current.length) {
        return false;
      }
      current = current[Number(segment)];
    } else if (isJsonObject(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      return false;
    }
  }
  return true;
}

function captureApplyResourceValues(
  host: BlockstateApplyLoweringHost,
  lower: (capturingHost: BlockstateApplyLoweringHost) => LoweredBlockstateApplyCore | undefined
): LoweredBlockstateApply | undefined {
  const resourceValueObservations: RsglResourceValueObservation[] = [];
  const lowered = lower({
    ...host,
    onResourceValueObservation: observation => resourceValueObservations.push(observation)
  });
  return lowered
    ? { ...lowered, resourceValueObservations }
    : undefined;
}

function withResourceValuePathPrefix(
  host: BlockstateApplyLoweringHost,
  generatedPathPrefix: string
): BlockstateApplyLoweringHost {
  const observe = host.onResourceValueObservation;
  if (!observe) {
    return host;
  }
  return {
    ...host,
    onResourceValueObservation: observation => observe({
      ...observation,
      generatedPath: joinGeneratedPath(generatedPathPrefix, observation.generatedPath)
    })
  };
}

function lowerBlockstateJsonValue(
  result: EvaluationResult,
  fallbackRange: TextRange,
  context: RsglCompileContext,
  host: BlockstateApplyLoweringHost,
  generatedPathPrefix = ""
): JsonValue | undefined {
  const loweringHost = createJsonValueLoweringHost(context, host);
  loweringHost.generatedPathPrefix = generatedPathPrefix;
  return lowerJsonEvaluationResult(result, fallbackRange, loweringHost);
}

const knownModelFields = new Set(["x", "y", "z", "uvlock", "weight"]);
