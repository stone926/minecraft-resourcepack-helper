import type { ForStmtNode, TextRange } from "../parser";
import {
  EvaluationContext,
  type EvaluationOrigin,
  EvaluationValue,
  childEvaluationContext,
  evaluateExpression,
  expressionEvaluationPathOrigins
} from "./evaluate";
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
  sourceRange: { start: number; end: number },
  bindingOrigins: ReadonlyMap<string, EvaluationOrigin> = new Map()
): EvaluationContext {
  const loopReason = context.mappingReason === "direct" || !context.mappingReason
    ? "loop"
    : context.mappingReason;
  const loopContext = childEvaluationContext(context, bindings, {
    mappingReason: loopReason,
    expansionStack: [
      ...(context.expansionStack ?? []),
      { label: "for", sourceRange }
    ]
  });
  loopContext.valueOrigins = new Map([
    ...(context.valueOrigins ?? []),
    ...bindingOrigins
  ]);
  return loopContext;
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

  const walk = (
    index: number,
    bindings: Record<string, EvaluationValue>,
    bindingOrigins: Map<string, EvaluationOrigin>
  ): void => {
    if (index >= dimensions.length) {
      visit(createLoopContext(context, bindings, statement.range, bindingOrigins));
      return;
    }

    const dimension = dimensions[index];
    const iterableContext = childEvaluationContext(context, bindings);
    iterableContext.valueOrigins = new Map([
      ...(context.valueOrigins ?? []),
      ...bindingOrigins
    ]);
    const iterable = evaluateExpression(dimension.iterable, iterableContext);
    if (!Array.isArray(iterable)) {
      onError("rsgl.compileNonFiniteLoop", "for input must evaluate to a finite list.", dimension.iterable.range);
      return;
    }
    const iterableOrigins = expressionEvaluationPathOrigins(dimension.iterable, iterableContext, "");
    for (const [valueIndex, value] of iterable.entries()) {
      const indexedPath = `/${valueIndex}`;
      const iterableOrigin = [...iterableOrigins].reverse().find(origin =>
        origin.generatedPath === indexedPath || origin.generatedPath.startsWith(`${indexedPath}/`)
      ) ?? [...iterableOrigins].reverse().find(origin => origin.generatedPath === "");
      const nextOrigins = new Map(bindingOrigins);
      for (const binding of dimension.bindings) {
        if (iterableOrigin) {
          nextOrigins.set(binding.text, iterableOrigin);
        } else {
          nextOrigins.delete(binding.text);
        }
      }
      walk(index + 1, {
        ...bindings,
        ...createLoopBindings(dimension.bindings.map(binding => binding.text), value)
      }, nextOrigins);
    }
  };

  walk(0, {}, new Map());
}
