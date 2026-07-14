import type { ForStmtNode, TextRange } from "../parser";
import {
  EvaluationContext,
  type EvaluationOrigin,
  type EvaluationPathOrigin,
  type EvaluationValueIssue,
  EvaluationValue,
  childEvaluationContext,
  evaluateExpressionResult,
  materializeEvaluationPathOrigins,
  materializeEvaluationValueIssues,
  originForEvaluationPath,
  selectEvaluationPathOrigins,
  selectEvaluationValueIssues
} from "./evaluate";
import { jsonObjectEntries } from "./jsonObjectProperties";
import { isJsonObject } from "./jsonValues";

export function createLoopBindings(names: string[], value: EvaluationValue): Record<string, EvaluationValue> {
  const bindings: Record<string, EvaluationValue> = {};
  if (names.length <= 1) {
    if (names[0]) {
      bindings[names[0]] = value;
    }
    return bindings;
  }

  if (isJsonObject(value)) {
    const entries = jsonObjectEntries(value);
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
  bindingOrigins: ReadonlyMap<string, EvaluationOrigin> = new Map(),
  bindingPathOrigins: ReadonlyMap<string, readonly EvaluationPathOrigin[]> = new Map(),
  bindingValueIssues: ReadonlyMap<string, readonly EvaluationValueIssue[]> = new Map()
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
  loopContext.valuePathOrigins = new Map([
    ...(context.valuePathOrigins ?? []),
    ...bindingPathOrigins
  ]);
  loopContext.valueIssues = new Map([
    ...(context.valueIssues ?? []),
    ...bindingValueIssues
  ]);
  return loopContext;
}

export function forEachLoopContext(
  statement: ForStmtNode,
  context: EvaluationContext,
  onError: (code: string, message: string, range: TextRange) => void,
  visit: (context: EvaluationContext) => void
): void {
  const dimensions = statement.dimensions;

  const walk = (
    index: number,
    bindings: Record<string, EvaluationValue>,
    bindingOrigins: Map<string, EvaluationOrigin>,
    bindingPathOrigins: Map<string, readonly EvaluationPathOrigin[]>,
    bindingValueIssues: Map<string, readonly EvaluationValueIssue[]>
  ): void => {
    if (index >= dimensions.length) {
      visit(createLoopContext(
        context,
        bindings,
        statement.range,
        bindingOrigins,
        bindingPathOrigins,
        bindingValueIssues
      ));
      return;
    }

    const dimension = dimensions[index];
    const iterableContext = childEvaluationContext(context, bindings);
    iterableContext.valueOrigins = new Map([
      ...(context.valueOrigins ?? []),
      ...bindingOrigins
    ]);
    iterableContext.valuePathOrigins = new Map([
      ...(context.valuePathOrigins ?? []),
      ...bindingPathOrigins
    ]);
    iterableContext.valueIssues = new Map([
      ...(context.valueIssues ?? []),
      ...bindingValueIssues
    ]);
    let evaluationFailed = false;
    const parentEvaluationFailure = iterableContext.onEvaluationFailure;
    iterableContext.onEvaluationFailure = () => {
      evaluationFailed = true;
      parentEvaluationFailure?.();
    };
    const iterableResult = evaluateExpressionResult(dimension.iterable, iterableContext);
    const iterable = iterableResult.value;
    if (!Array.isArray(iterable)) {
      if (!evaluationFailed) {
        onError("rsgl.compileNonFiniteLoop", "for input must evaluate to a finite list.", dimension.iterable.range);
      }
      return;
    }
    const iterableOrigins = materializeEvaluationPathOrigins(
      iterableResult,
      iterableContext.sourceFile
    );
    const iterableIssues = materializeEvaluationValueIssues(
      iterableResult,
      iterableContext.sourceFile
    );
    for (const [valueIndex, value] of iterable.entries()) {
      const indexedPath = `/${valueIndex}`;
      const itemOrigins = selectEvaluationPathOrigins(iterableOrigins, indexedPath);
      const itemIssues = selectEvaluationValueIssues(iterableIssues, indexedPath);
      const iterableOrigin = originForEvaluationPath(itemOrigins, "");
      const nextOrigins = new Map(bindingOrigins);
      const nextPathOrigins = new Map(bindingPathOrigins);
      const nextValueIssues = new Map(bindingValueIssues);
      const objectEntries = isJsonObject(value)
        ? jsonObjectEntries(value)
        : [];
      for (const [bindingIndex, binding] of dimension.bindings.entries()) {
        const bindingItemOrigins = dimension.bindings.length <= 1
          ? itemOrigins
          : objectEntries[bindingIndex]
            ? selectEvaluationPathOrigins(
                itemOrigins,
                `/${escapeJsonPointerSegment(objectEntries[bindingIndex][0])}`
              )
            : [];
        const bindingItemIssues = dimension.bindings.length <= 1
          ? itemIssues
          : objectEntries[bindingIndex]
            ? selectEvaluationValueIssues(
                itemIssues,
                `/${escapeJsonPointerSegment(objectEntries[bindingIndex][0])}`
              )
            : [];
        const bindingOrigin = originForEvaluationPath(bindingItemOrigins, "") ?? iterableOrigin;
        if (bindingOrigin) {
          nextOrigins.set(binding.text, bindingOrigin);
        } else {
          nextOrigins.delete(binding.text);
        }
        if (bindingItemOrigins.length > 0) {
          nextPathOrigins.set(binding.text, bindingItemOrigins);
        } else {
          nextPathOrigins.delete(binding.text);
        }
        if (bindingItemIssues.length > 0) {
          nextValueIssues.set(binding.text, bindingItemIssues);
        } else {
          nextValueIssues.delete(binding.text);
        }
      }
      walk(index + 1, {
        ...bindings,
        ...createLoopBindings(dimension.bindings.map(binding => binding.text), value)
      }, nextOrigins, nextPathOrigins, nextValueIssues);
    }
  };

  walk(0, {}, new Map(), new Map(), new Map());
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
