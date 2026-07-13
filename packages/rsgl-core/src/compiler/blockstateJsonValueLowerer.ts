import type { TextRange } from "../parser";
import type { EvaluationResult, EvaluationValueIssue } from "./evaluate";
import type { JsonValue } from "./ir";
import {
  type JsonRuntimeValueAdapter,
  type JsonValueLoweringFailure,
  lowerJsonEvaluationResult
} from "./jsonValueLowerer";
import {
  resourceValueJsonAdapters,
  type RsglResourceValueObserver
} from "./resourceValueJsonAdapter";

export interface BlockstateJsonValueLoweringHost {
  onError: (code: string, message: string, range: TextRange, fileName?: string) => void;
  jsonValueAdapters?: readonly JsonRuntimeValueAdapter[];
  onResourceValueObservation?: RsglResourceValueObserver;
  sourceFile?: string;
}

/**
 * Blockstate compatibility wrapper around the shared recursive JSON lowerer.
 * It preserves the established diagnostic code/message and issue priority
 * while using the same serializability assertion as every other JSON sink.
 */
export function lowerSerializableBlockstateJsonValue(
  result: EvaluationResult,
  fallbackRange: TextRange,
  host: BlockstateJsonValueLoweringHost,
  generatedPathPrefix = ""
): JsonValue | undefined {
  return lowerJsonEvaluationResult(result, fallbackRange, {
    adapters: resourceValueJsonAdapters(
      host.jsonValueAdapters,
      host.onResourceValueObservation
    ),
    reporter: {
      selectIssue: selectBlockstateIssue,
      report: failure => reportUnserializable(failure, host)
    },
    generatedPathPrefix,
    sourceFile: host.sourceFile
  });
}

function selectBlockstateIssue(
  issues: readonly EvaluationValueIssue[]
): EvaluationValueIssue | undefined {
  return issues.find(item =>
    item.kind === "duplicateObjectKey" || item.kind === "invalidObjectKey"
  ) ?? issues[0];
}

function reportUnserializable(
  failure: JsonValueLoweringFailure,
  host: BlockstateJsonValueLoweringHost
): void {
  const location = failure.generatedPath || "<root>";
  if (failure.kind === "moduleNamespace") {
    host.onError(
      "rsgl.moduleNamespaceValueNotSerializable",
      `Module namespace at '${location}' cannot be emitted as JSON.`,
      failure.range,
      failure.sourceFile
    );
    return;
  }
  host.onError(
    "rsgl.unserializableBlockstateJsonValue",
    `Blockstate model value at '${location}' is not JSON-serializable (${describeFailure(failure.kind)}).`,
    failure.range,
    failure.sourceFile
  );
}

function describeFailure(kind: JsonValueLoweringFailure["kind"]): string {
  if (kind === "duplicateObjectKey") {
    return "duplicate computed object key";
  }
  if (kind === "invalidObjectKey") {
    return "computed object key without a value";
  }
  if (kind === "runtimeObject") {
    return "runtime object";
  }
  if (kind === "cyclicObject") {
    return "cyclic object";
  }
  return kind;
}
