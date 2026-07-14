import type { ExprNode } from "../parser";
import { blockstateVariantKey } from "./blockstateKeys";
import {
  evaluateExpressionResult,
  type EvaluationOrigin,
  originForEvaluationPath
} from "./evaluate";
import {
  createJsonValueLoweringHost,
  type JsonValueSinkOptions,
  lowerJsonEvaluationResult
} from "./jsonValueLowerer";
import { cloneJsonObject, isJsonObject } from "./jsonValues";
import type { JsonValue } from "./ir";
import type { RsglCompileContext } from "./templateExpansion";

export interface BlockstateSelectorLoweringHost extends JsonValueSinkOptions {
  onError: NonNullable<JsonValueSinkOptions["onError"]>;
}

export interface LoweredBlockstateSelector {
  readonly key: string;
  readonly value: Record<string, JsonValue>;
  readonly origin?: EvaluationOrigin;
}

export interface LoweredBlockstateCondition {
  readonly value: Record<string, JsonValue>;
  readonly origin?: EvaluationOrigin;
}

/** Evaluates and canonicalizes a variants selector exactly once. */
export function lowerBlockstateSelector(
  expression: ExprNode,
  context: RsglCompileContext,
  host: BlockstateSelectorLoweringHost
): LoweredBlockstateSelector | undefined {
  const result = evaluateExpressionResult(expression, context);
  const keyIssue = result.valueIssues.find(issue =>
    issue.kind === "duplicateObjectKey" || issue.kind === "invalidObjectKey"
  );
  if (keyIssue) {
    host.onError(
      keyIssue.kind === "duplicateObjectKey"
        ? "rsgl.duplicateBlockstateSelectorProperty"
        : "rsgl.invalidBlockstateSelectorKey",
      keyIssue.kind === "duplicateObjectKey"
        ? "A blockstate selector property resolves to a duplicate canonical key."
        : "A computed blockstate selector key must evaluate to a scalar value.",
      keyIssue.sourceRange,
      keyIssue.sourceFile
    );
    return undefined;
  }
  const value = lowerJsonEvaluationResult(
    result,
    expression.range,
    createJsonValueLoweringHost(context, host)
  );
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    host.onError(
      "rsgl.invalidBlockstateSelector",
      "A blockstate variants selector must evaluate to an object.",
      expression.range
    );
    return undefined;
  }
  if (!Object.values(value).every(isBlockstateStateValue)) {
    host.onError(
      "rsgl.invalidBlockstateSelectorValue",
      "Blockstate variants selector values must be strings, numbers, or booleans.",
      expression.range
    );
    return undefined;
  }
  const cloned = cloneJsonObject(value);
  const origin = originForEvaluationPath(result.pathOrigins, "") ?? result.origin;
  return {
    key: blockstateVariantKey(cloned),
    value: cloned,
    ...(origin ? { origin } : {})
  };
}

/** Multipart conditions retain their JSON object structure and ordering. */
export function lowerBlockstateCondition(
  expression: ExprNode,
  context: RsglCompileContext,
  host: BlockstateSelectorLoweringHost
): LoweredBlockstateCondition | undefined {
  const result = evaluateExpressionResult(expression, context);
  const keyIssue = result.valueIssues.find(issue =>
    issue.kind === "duplicateObjectKey" || issue.kind === "invalidObjectKey"
  );
  if (keyIssue) {
    host.onError(
      keyIssue.kind === "duplicateObjectKey"
        ? "rsgl.duplicateBlockstateSelectorProperty"
        : "rsgl.invalidBlockstateSelectorKey",
      keyIssue.kind === "duplicateObjectKey"
        ? "A blockstate condition property resolves to a duplicate canonical key."
        : "A computed blockstate condition key must evaluate to a scalar value.",
      keyIssue.sourceRange,
      keyIssue.sourceFile
    );
    return undefined;
  }
  const value = lowerJsonEvaluationResult(
    result,
    expression.range,
    createJsonValueLoweringHost(context, host)
  );
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    host.onError(
      "rsgl.invalidBlockstateCondition",
      "A blockstate multipart condition must evaluate to an object.",
      expression.range
    );
    return undefined;
  }
  const origin = originForEvaluationPath(result.pathOrigins, "") ?? result.origin;
  return {
    value: cloneJsonObject(value),
    ...(origin ? { origin } : {})
  };
}

function isBlockstateStateValue(value: JsonValue): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
