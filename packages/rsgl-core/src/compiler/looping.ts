import type { ForStmtNode, TextRange } from "../parser";
import {
  forDimensionBindingMappings,
  type ForDimensionBindingMapping
} from "../forBindingPatterns";
import {
  EvaluationContext,
  type EvaluationOrigin,
  type EvaluationPathOrigin,
  type EvaluationValueIssue,
  EvaluationValue,
  childEvaluationContext,
  evaluateExpressionResult,
  materializeEvaluationPathOrigins,
  materializeEvaluationSelectionPathOrigins,
  materializeEvaluationValueIssues,
  originForEvaluationPath,
  selectEvaluationPathOrigins,
  selectEvaluationValueIssues
} from "./evaluate";
import { isJsonObject } from "./jsonValues";
import { ensureEvaluationItemsForExpansion } from "./evaluationItemAccounting";

function selectLoopBindings(
  mappings: readonly ForDimensionBindingMapping[],
  value: EvaluationValue,
  valueIndex: number
): Record<string, EvaluationValue> {
  const bindings = Object.create(null) as Record<string, EvaluationValue>;
  const objectValue = isJsonObject(value) ? value : undefined;
  for (const mapping of mappings) {
    if (mapping.kind === "wholeValue") {
      bindings[mapping.binding.text] = value;
    } else if (mapping.kind === "index") {
      bindings[mapping.binding.text] = valueIndex;
    } else {
      bindings[mapping.binding.text] = objectValue && Object.hasOwn(objectValue, mapping.property.text)
        ? objectValue[mapping.property.text] as EvaluationValue
        : undefined;
    }
  }
  return bindings;
}

export function createLoopContext(
  context: EvaluationContext,
  bindings: Record<string, EvaluationValue>,
  sourceRange: { start: number; end: number },
  bindingOrigins: ReadonlyMap<string, EvaluationOrigin> = new Map(),
  bindingPathOrigins: ReadonlyMap<string, readonly EvaluationPathOrigin[]> = new Map(),
  bindingSelectionPathOrigins: ReadonlyMap<string, readonly EvaluationPathOrigin[]> = new Map(),
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
  loopContext.valueSelectionPathOrigins = new Map([
    ...(context.valueSelectionPathOrigins ?? []),
    ...bindingSelectionPathOrigins
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
  visit: (context: EvaluationContext) => void,
  options: { readonly operation?: string } = {}
): void {
  const dimensions = statement.dimensions;

  const walk = (
    index: number,
    bindings: Record<string, EvaluationValue>,
    bindingOrigins: Map<string, EvaluationOrigin>,
    bindingPathOrigins: Map<string, readonly EvaluationPathOrigin[]>,
    bindingSelectionPathOrigins: Map<string, readonly EvaluationPathOrigin[]>,
    bindingValueIssues: Map<string, readonly EvaluationValueIssue[]>
  ): void => {
    if (index >= dimensions.length) {
      visit(createLoopContext(
        context,
        bindings,
        statement.range,
        bindingOrigins,
        bindingPathOrigins,
        bindingSelectionPathOrigins,
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
    iterableContext.valueSelectionPathOrigins = new Map([
      ...(context.valueSelectionPathOrigins ?? []),
      ...bindingSelectionPathOrigins
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
    const consumedBeforeEvaluation = iterableContext.evaluationItemBudget?.consumed ?? 0;
    const iterableResult = evaluateExpressionResult(dimension.iterable, iterableContext);
    const iterable = iterableResult.value;
    if (!Array.isArray(iterable)) {
      if (!evaluationFailed) {
        onError("rsgl.compileNonFiniteLoop", "for input must evaluate to a finite list.", dimension.iterable.range);
      }
      return;
    }
    if (!ensureEvaluationItemsForExpansion(
      iterableContext,
      consumedBeforeEvaluation,
      iterable.length,
      dimension.iterable.range,
      options.operation ?? "for expansion",
      (code, message, range) => onError(code, message, range)
    )) {
      return;
    }
    const iterableOrigins = materializeEvaluationPathOrigins(
      iterableResult,
      iterableContext.sourceFile
    );
    const iterableSelectionOrigins = materializeEvaluationSelectionPathOrigins(
      iterableResult,
      iterableContext.sourceFile
    );
    const iterableIssues = materializeEvaluationValueIssues(
      iterableResult,
      iterableContext.sourceFile
    );
    const bindingMappings = forDimensionBindingMappings(dimension);
    for (const [valueIndex, value] of iterable.entries()) {
      const indexedPath = `/${valueIndex}`;
      const itemOrigins = selectEvaluationPathOrigins(iterableOrigins, indexedPath);
      const itemSelectionOrigins = selectEvaluationPathOrigins(
        iterableSelectionOrigins,
        indexedPath
      );
      const itemIssues = selectEvaluationValueIssues(iterableIssues, indexedPath);
      const iterableOrigin = originForEvaluationPath(itemOrigins, "");
      const nextOrigins = new Map(bindingOrigins);
      const nextPathOrigins = new Map(bindingPathOrigins);
      const nextSelectionPathOrigins = new Map(bindingSelectionPathOrigins);
      const nextValueIssues = new Map(bindingValueIssues);
      const selectedBindings = selectLoopBindings(bindingMappings, value, valueIndex);
      for (const mapping of bindingMappings) {
        const sourceProperty = mapping.kind === "objectProperty"
          ? mapping.property.text
          : undefined;
        const indexOrigin: EvaluationOrigin | undefined = mapping.kind === "index" && context.sourceFile
          ? { sourceFile: context.sourceFile, sourceRange: mapping.binding.range }
          : undefined;
        const bindingItemOrigins: readonly EvaluationPathOrigin[] = indexOrigin
          ? [{ ...indexOrigin, generatedPath: "" }]
          : mapping.kind === "wholeValue"
            ? itemOrigins
            : sourceProperty !== undefined
              ? selectEvaluationPathOrigins(
                  itemOrigins,
                  `/${escapeJsonPointerSegment(sourceProperty)}`
                )
              : [];
        const bindingItemIssues: readonly EvaluationValueIssue[] = mapping.kind === "index"
          ? []
          : mapping.kind === "wholeValue"
            ? itemIssues
            : sourceProperty !== undefined
              ? selectEvaluationValueIssues(
                  itemIssues,
                  `/${escapeJsonPointerSegment(sourceProperty)}`
                )
              : [];
        const bindingItemSelectionOrigins: readonly EvaluationPathOrigin[] = indexOrigin
          ? [{ ...indexOrigin, generatedPath: "" }]
          : mapping.kind === "wholeValue"
            ? itemSelectionOrigins
            : sourceProperty !== undefined
              ? selectEvaluationPathOrigins(
                  itemSelectionOrigins,
                  `/${escapeJsonPointerSegment(sourceProperty)}`
                )
              : [];
        const bindingOrigin = indexOrigin
          ?? originForEvaluationPath(bindingItemOrigins, "")
          ?? iterableOrigin;
        const bindingName = mapping.binding.text;
        if (bindingOrigin) {
          nextOrigins.set(bindingName, bindingOrigin);
        } else {
          nextOrigins.delete(bindingName);
        }
        if (bindingItemOrigins.length > 0) {
          nextPathOrigins.set(bindingName, bindingItemOrigins);
        } else {
          nextPathOrigins.delete(bindingName);
        }
        if (bindingItemSelectionOrigins.length > 0) {
          nextSelectionPathOrigins.set(bindingName, bindingItemSelectionOrigins);
        } else {
          nextSelectionPathOrigins.delete(bindingName);
        }
        if (bindingItemIssues.length > 0) {
          nextValueIssues.set(bindingName, bindingItemIssues);
        } else {
          nextValueIssues.delete(bindingName);
        }
      }
      walk(index + 1, {
        ...bindings,
        ...selectedBindings
      }, nextOrigins, nextPathOrigins, nextSelectionPathOrigins, nextValueIssues);
    }
  };

  walk(0, {}, new Map(), new Map(), new Map(), new Map());
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
