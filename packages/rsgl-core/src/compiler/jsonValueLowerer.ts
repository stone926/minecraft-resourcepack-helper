import type { ExprNode, TextRange } from "../parser";
import {
  type EvaluationContext,
  type EvaluationResult,
  type EvaluationValueIssue,
  evaluateExpressionResult,
  originForEvaluationPath,
  rangeForEvaluationPath
} from "./evaluate";
import type { JsonValue } from "./ir";
import {
  createJsonObject,
  jsonObjectEntries,
  setJsonObjectProperty
} from "./jsonObjectProperties";
import { isJsonObject } from "./jsonValues";
import {
  resourceValueJsonAdapters,
  type RsglResourceValueObserver
} from "./resourceValueJsonAdapter";
import { appendGeneratedPath, joinGeneratedPath } from "./sourcePaths";
import { isModuleNamespaceValue } from "./moduleNamespaceValue";
import {
  isStateNamespaceValue,
  isStatePredicateValue,
  isStatePropertyValue
} from "./blockstatePredicate";

export interface JsonValueSinkOptions {
  onError?: (code: string, message: string, range: TextRange, fileName?: string) => void;
  /** Marks the enclosing resource invalid so a partial JSON unit is never emitted. */
  onInvalidJsonValue?: () => void;
  /** Runtime adapters extend lowering without weakening recursive serializability checks. */
  jsonValueAdapters?: readonly JsonRuntimeValueAdapter[];
  /** Collects typed resource values at their final generated JSON paths. */
  onResourceValueObservation?: RsglResourceValueObserver;
}

export interface JsonRuntimeValueAdapterContext {
  generatedPath: string;
  range: TextRange;
  /** Most specific executed expression, independent from diagnostic provenance. */
  valueLocation?: {
    range: TextRange;
    sourceFile?: string;
  };
  sourceFile?: string;
}

export type JsonRuntimeValueAdapterResult =
  | { kind: "value"; value: JsonValue }
  | { kind: "error"; code: string; message: string };

/**
 * Converts a compiler-only runtime value (for example, a future branded ID)
 * into JSON, or rejects it with a domain-specific diagnostic. Returning
 * undefined means the adapter does not own that value.
 */
export interface JsonRuntimeValueAdapter {
  lower(
    value: unknown,
    context: JsonRuntimeValueAdapterContext
  ): JsonRuntimeValueAdapterResult | undefined;
}

export type JsonRuntimeValueIssueKind =
  | "undefined"
  | "moduleNamespace"
  | "nonFiniteNumber"
  | "runtimeObject"
  | "cyclicObject";

export interface JsonValueLoweringFailure {
  generatedPath: string;
  kind: EvaluationValueIssue["kind"] | JsonRuntimeValueIssueKind;
  range: TextRange;
  sourceFile?: string;
  diagnostic?: { code: string; message: string };
}

export interface JsonValueLoweringReporter {
  selectIssue?: (
    issues: readonly EvaluationValueIssue[]
  ) => EvaluationValueIssue | undefined;
  report: (failure: JsonValueLoweringFailure) => void;
}

export interface JsonValueLoweringHost {
  reporter: JsonValueLoweringReporter;
  onInvalidJsonValue?: () => void;
  adapters?: readonly JsonRuntimeValueAdapter[];
  generatedPathPrefix?: string;
  /** Fallback origin when the evaluated value has no bound/imported origin. */
  sourceFile?: string;
}

export interface EvaluatedJsonExpression {
  value: JsonValue;
  result: EvaluationResult;
}

/** Evaluates an expression exactly once, then lowers it at a real JSON sink. */
export function evaluateJsonExpression(
  expression: ExprNode,
  context: EvaluationContext,
  options: JsonValueSinkOptions = {},
  generatedPath = ""
): JsonValue | undefined {
  return evaluateJsonExpressionWithResult(expression, context, options, generatedPath)?.value;
}

/**
 * Evaluates and lowers once while retaining the exact provenance trace for
 * source-map consumers. Collection mappers are never replayed for origins.
 */
export function evaluateJsonExpressionWithResult(
  expression: ExprNode,
  context: EvaluationContext,
  options: JsonValueSinkOptions = {},
  generatedPath = ""
): EvaluatedJsonExpression | undefined {
  const host = createJsonValueLoweringHost(context, options);
  host.generatedPathPrefix = generatedPath;
  let evaluationFailed = false;
  const onError = options.onError ?? context.onError;
  const evaluationContext: EvaluationContext = {
    ...context,
    onEvaluationFailure: () => {
      evaluationFailed = true;
      context.onEvaluationFailure?.();
    },
    ...(onError
      ? {
          onError: (code, message, range, fileName) => {
            evaluationFailed = true;
            onError(code, message, range, fileName);
          }
        }
      : {})
  };
  const result = evaluateExpressionResult(expression, evaluationContext);
  if (evaluationFailed) {
    // The evaluator already reported the root cause (for example, a dynamic
    // bounds failure). The sink is still invalid, but reporting the resulting
    // undefined as Missing would only create a misleading cascade.
    options.onInvalidJsonValue?.();
    return undefined;
  }
  const value = lowerJsonEvaluationResult(
    result,
    expression.range,
    host
  );
  return value === undefined ? undefined : { value, result };
}

/**
 * Shared recursive lowering for every RSGL JSON sink.
 *
 * Internal evaluator control-flow may still use undefined. Calling this
 * function is the explicit boundary at which undefined, functions, cyclic
 * structures, and other compiler-only values become errors.
 */
export function lowerJsonEvaluationResult(
  result: EvaluationResult,
  fallbackRange: TextRange,
  host: JsonValueLoweringHost
): JsonValue | undefined {
  const serializableIssues = result.valueIssues.filter(issue =>
    issue.kind !== "stateRecordDuplicateObjectKey"
  );
  const issue = host.reporter.selectIssue
    ? host.reporter.selectIssue(serializableIssues)
    : serializableIssues[0];
  if (issue) {
    fail(host, {
      generatedPath: issue.generatedPath,
      kind: issue.kind,
      range: issue.sourceRange,
      sourceFile: issue.sourceFile
    });
    return undefined;
  }
  return cloneSerializableValue(
    result.value,
    "",
    fallbackRange,
    result,
    host,
    new Set<object>()
  );
}

/** Creates the shared lowering boundary used by every JSON-emitting domain. */
export function createJsonValueLoweringHost(
  context: EvaluationContext,
  options: JsonValueSinkOptions
): JsonValueLoweringHost {
  const onError = options.onError ?? context.onError;
  return {
    onInvalidJsonValue: options.onInvalidJsonValue,
    adapters: resourceValueJsonAdapters(
      options.jsonValueAdapters,
      options.onResourceValueObservation
    ),
    sourceFile: context.sourceFile,
    reporter: {
      report: failure => {
        if (!onError) {
          return;
        }
        const sourceFile = failure.sourceFile ?? context.sourceFile;
        const location = failure.generatedPath || "<root>";
        if (failure.diagnostic) {
          onError(
            failure.diagnostic.code,
            failure.diagnostic.message,
            failure.range,
            sourceFile
          );
          return;
        }
        if (failure.kind === "lambda") {
          onError(
            "rsgl.functionValueNotSerializable",
            `Function value at '${location}' cannot be emitted as JSON.`,
            failure.range,
            sourceFile
          );
          return;
        }
        if (failure.kind === "undefined") {
          onError(
            "rsgl.missingValueNotSerializable",
            `Missing or undefined value at '${location}' cannot be emitted as JSON.`,
            failure.range,
            sourceFile
          );
          return;
        }
        if (failure.kind === "moduleNamespace") {
          onError(
            "rsgl.moduleNamespaceValueNotSerializable",
            `Module namespace at '${location}' cannot be emitted as JSON.`,
            failure.range,
            sourceFile
          );
          return;
        }
        onError(
          "rsgl.unserializableJsonValue",
          `Value at '${location}' is not JSON-serializable (${describeFailure(failure.kind)}).`,
          failure.range,
          sourceFile
        );
      }
    }
  };
}

function cloneSerializableValue(
  value: unknown,
  generatedPath: string,
  fallbackRange: TextRange,
  result: EvaluationResult,
  host: JsonValueLoweringHost,
  ancestors: Set<object>
): JsonValue | undefined {
  const origin = originForEvaluationPath(result.pathOrigins, generatedPath);
  const range = origin?.sourceRange
    ?? rangeForEvaluationPath(result.pathRanges, generatedPath)
    ?? fallbackRange;
  const sourceFile = origin?.sourceFile
    ?? result.origin?.sourceFile
    ?? host.sourceFile;
  const selectionOrigin = originForEvaluationPath(
    result.selectionPathOrigins,
    generatedPath
  );
  const valueRange = selectionOrigin?.sourceRange
    ?? rangeForEvaluationPath(result.valuePathRanges, generatedPath)
    ?? range;
  const valueSourceFile = selectionOrigin?.sourceFile
    ?? host.sourceFile
    ?? sourceFile;
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value;
    }
    fail(host, { generatedPath, kind: "nonFiniteNumber", range, sourceFile });
    return undefined;
  }
  if (value === undefined) {
    fail(host, { generatedPath, kind: "undefined", range, sourceFile });
    return undefined;
  }
  if (isLambdaRuntimeValue(value)) {
    fail(host, { generatedPath, kind: "lambda", range, sourceFile });
    return undefined;
  }
  if (isModuleNamespaceValue(value)) {
    fail(host, { generatedPath, kind: "moduleNamespace", range, sourceFile });
    return undefined;
  }
  if (isStateNamespaceValue(value) || isStatePropertyValue(value) || isStatePredicateValue(value)) {
    fail(host, { generatedPath, kind: "runtimeObject", range, sourceFile });
    return undefined;
  }
  const objectValue = value && typeof value === "object" ? value : undefined;
  if (objectValue && ancestors.has(objectValue)) {
    fail(host, { generatedPath, kind: "cyclicObject", range, sourceFile });
    return undefined;
  }

  const adapterContext: JsonRuntimeValueAdapterContext = {
    generatedPath: joinGeneratedPath(host.generatedPathPrefix ?? "", generatedPath),
    range,
    valueLocation: {
      range: valueRange,
      ...(valueSourceFile ? { sourceFile: valueSourceFile } : {})
    },
    ...(sourceFile ? { sourceFile } : {})
  };
  for (const adapter of host.adapters ?? []) {
    const adapted = adapter.lower(value, adapterContext);
    if (!adapted) {
      continue;
    }
    if (adapted.kind === "error") {
      fail(host, {
        generatedPath,
        kind: "runtimeObject",
        range,
        sourceFile,
        diagnostic: { code: adapted.code, message: adapted.message }
      });
      return undefined;
    }
    if (adapted.value === value) {
      fail(host, { generatedPath, kind: "runtimeObject", range, sourceFile });
      return undefined;
    }
    if (objectValue) {
      ancestors.add(objectValue);
    }
    const lowered = cloneSerializableValue(
      adapted.value,
      generatedPath,
      fallbackRange,
      result,
      host,
      ancestors
    );
    if (objectValue) {
      ancestors.delete(objectValue);
    }
    return lowered;
  }

  if (!Array.isArray(value) && !isJsonObject(value)) {
    fail(host, { generatedPath, kind: "runtimeObject", range, sourceFile });
    return undefined;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    const cloned: JsonValue[] = [];
    for (const [index, item] of value.entries()) {
      const child = cloneSerializableValue(
        item,
        appendGeneratedPath(generatedPath, String(index)),
        fallbackRange,
        result,
        host,
        ancestors
      );
      if (child === undefined) {
        ancestors.delete(value);
        return undefined;
      }
      cloned.push(child);
    }
    ancestors.delete(value);
    return cloned;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    ancestors.delete(value);
    fail(host, { generatedPath, kind: "runtimeObject", range, sourceFile });
    return undefined;
  }
  const cloned = createJsonObject(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  for (const [key, item] of jsonObjectEntries(value)) {
    const child = cloneSerializableValue(
      item,
      appendGeneratedPath(generatedPath, key),
      fallbackRange,
      result,
      host,
      ancestors
    );
    if (child === undefined) {
      ancestors.delete(value);
      return undefined;
    }
    setJsonObjectProperty(cloned, key, child);
  }
  ancestors.delete(value);
  return cloned;
}

function fail(host: JsonValueLoweringHost, failure: JsonValueLoweringFailure): void {
  host.onInvalidJsonValue?.();
  host.reporter.report({
    ...failure,
    generatedPath: joinGeneratedPath(host.generatedPathPrefix ?? "", failure.generatedPath)
  });
}

function describeFailure(kind: JsonValueLoweringFailure["kind"]): string {
  if (kind === "duplicateObjectKey") {
    return "duplicate computed object key";
  }
  if (kind === "invalidObjectKey") {
    return "computed object key without a value";
  }
  if (kind === "runtimeObject") {
    return "compiler runtime object";
  }
  if (kind === "cyclicObject") {
    return "cyclic object";
  }
  return kind;
}

function isLambdaRuntimeValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as {
    kind?: string;
    parameters?: unknown;
    body?: unknown;
    context?: unknown;
    impureCalls?: unknown;
  };
  return candidate.kind === "lambda"
    && Array.isArray(candidate.parameters)
    && Boolean(candidate.body && typeof candidate.body === "object")
    && Boolean(candidate.context && typeof candidate.context === "object")
    && Array.isArray(candidate.impureCalls);
}
