import type { ForStmtNode, TextRange } from "../parser";
import { EvaluationContext, EvaluationValue, childEvaluationContext } from "./evaluate";
import { evaluateExpression } from "./evaluate";
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

export function forEachLoopContext(
  statement: ForStmtNode,
  context: EvaluationContext,
  onError: (code: string, message: string, range: TextRange) => void,
  visit: (context: EvaluationContext) => void
): void {
  const dimensions = statement.dimensions.length ? statement.dimensions : [{
    kind: "ForDimension" as const,
    bindings: statement.bindings,
    iterable: statement.iterable,
    range: statement.range,
    fullRange: statement.fullRange
  }];

  const walk = (index: number, bindings: Record<string, EvaluationValue>): void => {
    if (index >= dimensions.length) {
      visit(createLoopContext(context, bindings, statement.range));
      return;
    }

    const dimension = dimensions[index];
    const iterableContext = childEvaluationContext(context, bindings);
    const iterable = evaluateExpression(dimension.iterable, iterableContext);
    if (!Array.isArray(iterable)) {
      onError("rsgl.compileNonFiniteLoop", "for input must evaluate to a finite list.", dimension.iterable.range);
      return;
    }
    for (const value of iterable) {
      walk(index + 1, {
        ...bindings,
        ...createLoopBindings(dimension.bindings.map(binding => binding.text), value)
      });
    }
  };

  walk(0, {});
}
