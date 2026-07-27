import type {
  BlockstateModelSpecNode,
  ExprNode,
  ObjectPropertyNode,
  TextRange
} from "../parser";
import {
  blockstateModelOptionNameSet,
  blockstateModelOptionType
} from "../blockstateModelOptions";
import { blockstateModelOptionMessages } from "../diagnosticMessages";
import type { RsglResourceValueObservation } from "./evaluatedResourceValues";
import {
  evaluateExpressionResult,
  type EvaluationOrigin,
  originForEvaluationPath,
  rangeForEvaluationPath
} from "./evaluate";
import type { JsonValue } from "./ir";
import {
  createJsonValueLoweringHost,
  type JsonValueSinkOptions,
  lowerJsonEvaluationResult
} from "./jsonValueLowerer";
import { parseResourceId, resourceIdToString } from "./resourceIds";
import { appendGeneratedPath } from "./sourcePaths";
import type { RsglCompileContext } from "./templateExpansion";

export interface BlockstateModelSpecLoweringHost extends JsonValueSinkOptions {
  onError: NonNullable<JsonValueSinkOptions["onError"]>;
}

export interface BlockstateModelSpecMapping {
  readonly generatedPath: string;
  readonly sourceRange: TextRange;
  readonly context: RsglCompileContext;
  readonly origin?: EvaluationOrigin;
}

export interface LoweredBlockstateModelSpec {
  readonly value: Record<string, JsonValue>;
  readonly mappings: readonly BlockstateModelSpecMapping[];
  readonly resourceValueObservations: readonly RsglResourceValueObservation[];
}

/** Lowers the only legal ModelSpec form: ModelId plus an optional `with` block. */
export function lowerBlockstateModelSpec(
  modelSpec: BlockstateModelSpecNode,
  context: RsglCompileContext,
  host: BlockstateModelSpecLoweringHost
): LoweredBlockstateModelSpec | undefined {
  const observations: RsglResourceValueObservation[] = [];
  let jsonLoweringFailed = false;
  const capturingHost: BlockstateModelSpecLoweringHost = {
    ...host,
    onError: (code, message, range, fileName) => {
      jsonLoweringFailed = true;
      host.onError(code, message, range, fileName);
    },
    onResourceValueObservation: observation => observations.push(observation)
  };
  let modelEvaluationFailed = false;
  const modelResult = evaluateExpressionResult(modelSpec.model, {
    ...context,
    onEvaluationFailure: () => {
      modelEvaluationFailed = true;
      context.onEvaluationFailure?.();
    }
  });
  if (modelEvaluationFailed) {
    return undefined;
  }
  const modelLoweringHost = createJsonValueLoweringHost(context, capturingHost);
  modelLoweringHost.generatedPathPrefix = "/model";
  const rawModel = lowerJsonEvaluationResult(
    modelResult,
    modelSpec.model.range,
    modelLoweringHost
  );
  if (jsonLoweringFailed) {
    return undefined;
  }
  const model = canonicalModelId(rawModel, context.namespace);
  if (!model) {
    host.onError(
      "rsgl.invalidBlockstateModelSpec",
      "A blockstate ModelSpec must start with a ModelId expression.",
      modelSpec.model.range,
      context.sourceFile
    );
    return undefined;
  }

  const value: Record<string, JsonValue> = { model };
  const mappings: BlockstateModelSpecMapping[] = [
    mapping("", modelSpec.range, context),
    mapping(
      "/model",
      rangeForEvaluationPath(modelResult.pathRanges, "") ?? modelSpec.model.range,
      context,
      originForEvaluationPath(modelResult.pathOrigins, "") ?? modelResult.origin
    )
  ];
  if (!modelSpec.options) {
    return { value, mappings, resourceValueObservations: observations };
  }

  const seen = new Set<string>();
  for (const property of modelSpec.options.properties) {
    if (property.kind === "ObjectSpread") {
      host.onError(
        "rsgl.invalidBlockstateModelOptionsSpread",
        blockstateModelOptionMessages.spreadNotAllowed,
        property.range,
        context.sourceFile
      );
      return undefined;
    }
    const name = staticPropertyName(property);
    if (!name || !blockstateModelOptionNameSet.has(name)) {
      host.onError(
        name === "weight"
          ? "rsgl.blockstateWeightInvalidContext"
          : "rsgl.unknownBlockstateModelField",
        name === "weight"
          ? blockstateModelOptionMessages.weightOutsideRandomChoice
          : blockstateModelOptionMessages.unknownOption(name ?? "computed"),
        property.key.range,
        context.sourceFile
      );
      return undefined;
    }
    if (seen.has(name)) {
      host.onError(
        "rsgl.duplicateBlockstateModelField",
        blockstateModelOptionMessages.duplicateOption(name),
        property.key.range,
        context.sourceFile
      );
      return undefined;
    }
    seen.add(name);
    let optionEvaluationFailed = false;
    const result = evaluateExpressionResult(property.value, {
      ...context,
      onEvaluationFailure: () => {
        optionEvaluationFailed = true;
        context.onEvaluationFailure?.();
      }
    });
    if (optionEvaluationFailed) {
      return undefined;
    }
    const loweringHost = createJsonValueLoweringHost(context, capturingHost);
    loweringHost.generatedPathPrefix = appendGeneratedPath("", name);
    jsonLoweringFailed = false;
    const option = lowerJsonEvaluationResult(result, property.value.range, loweringHost);
    if (jsonLoweringFailed) {
      return undefined;
    }
    if (!validateModelOption(name, option, property.value, context, host)) {
      return undefined;
    }
    if (!isDefaultModelOption(name, option)) {
      value[name] = option!;
      mappings.push(mapping(
        appendGeneratedPath("", name),
        rangeForEvaluationPath(result.pathRanges, "") ?? property.value.range,
        context,
        originForEvaluationPath(result.pathOrigins, "") ?? result.origin
      ));
    }
  }
  return { value, mappings, resourceValueObservations: observations };
}

function validateModelOption(
  name: string,
  value: JsonValue | undefined,
  expression: ExprNode,
  context: RsglCompileContext,
  host: BlockstateModelSpecLoweringHost
): boolean {
  if (blockstateModelOptionType(name) === "boolean") {
    if (typeof value === "boolean") {
      return true;
    }
    host.onError(
      "rsgl.invalidBlockstateUvlock",
      "Blockstate model uvlock must evaluate to a boolean.",
      expression.range,
      context.sourceFile
    );
    return false;
  }
  if (value === 0 || value === 90 || value === 180 || value === 270) {
    return true;
  }
  host.onError(
    "rsgl.invalidBlockstateRotation",
    blockstateModelOptionMessages.invalidRotation(name),
    expression.range,
    context.sourceFile
  );
  return false;
}

function isDefaultModelOption(name: string, value: JsonValue | undefined): boolean {
  return blockstateModelOptionType(name) === "boolean" ? value === false : value === 0;
}

function canonicalModelId(value: JsonValue | undefined, namespace: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = parseResourceId(value, namespace);
  return parsed ? resourceIdToString(parsed) : undefined;
}

function staticPropertyName(property: ObjectPropertyNode): string | undefined {
  if (property.key.kind === "Identifier") {
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  if (property.key.kind === "NumberLiteral") {
    return property.key.raw;
  }
  return undefined;
}

function mapping(
  generatedPath: string,
  sourceRange: TextRange,
  context: RsglCompileContext,
  origin?: EvaluationOrigin
): BlockstateModelSpecMapping {
  return { generatedPath, sourceRange, context, ...(origin ? { origin } : {}) };
}
