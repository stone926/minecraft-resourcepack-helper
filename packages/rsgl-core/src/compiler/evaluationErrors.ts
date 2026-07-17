import type { TextRange } from "../parser";
import type { EvaluationContext } from "./evaluationTypes";

export function reportContextualValueError(
  error: { code: string; message: string },
  range: TextRange,
  context: EvaluationContext,
  sourceFile = context.sourceFile
): void {
  context.onEvaluationFailure?.();
  context.onResourceValueFailure?.();
  context.onError?.(error.code, error.message, range, sourceFile);
}

export function reportInvalidSpread(
  context: EvaluationContext,
  code: "rsgl.invalidListSpread" | "rsgl.invalidObjectSpread",
  message: string,
  range: TextRange
): void {
  context.onEvaluationFailure?.();
  context.onError?.(code, message, range, context.sourceFile);
}
