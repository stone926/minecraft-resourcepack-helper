import { EvaluationContext, EvaluationValue, childEvaluationContext } from "./evaluate";
import { JsonValue } from "./ir";

export function createLoopBindings(names: string[], value: EvaluationValue): Record<string, EvaluationValue> {
  const bindings: Record<string, EvaluationValue> = {};
  if (names.length <= 1) {
    if (names[0]) {
      bindings[names[0]] = value;
    }
    return bindings;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, JsonValue>);
    names.forEach((name, index) => {
      bindings[name] = entries[index]?.[1];
    });
  }
  return bindings;
}

export function createLoopContext(
  context: EvaluationContext,
  bindings: Record<string, EvaluationValue>,
  sourceRange: { start: number; end: number }
): EvaluationContext {
  const loopReason = context.mappingReason === "direct" || !context.mappingReason
    ? "loop"
    : context.mappingReason;
  return childEvaluationContext(context, bindings, {
    mappingReason: loopReason,
    expansionStack: [
      ...(context.expansionStack ?? []),
      { label: "for", sourceRange }
    ]
  });
}
