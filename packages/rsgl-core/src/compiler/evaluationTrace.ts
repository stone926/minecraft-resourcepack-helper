import type { ExprNode, ObjectPropertyNode, TextRange } from "../parser";
import { staticPropertyKeyName } from "../parser";
import { isRsglResourceIdConstructorName } from "../resourceIdSemantics";
import type { CollectionEvaluationTrace } from "./collectionBuiltins";
import { isLambdaLikeValue } from "./evaluationJsonValues";
import { evaluationScalarText } from "./evaluatedResourceValues";
import {
  deduplicatePathEntries,
  deduplicateValueIssues,
  materializeEvaluationPathOrigins,
  materializeEvaluationSelectionPathOrigins,
  materializeEvaluationValueIssues,
  originForEvaluationPath,
  rangeForEvaluationPath,
  selectPathEntries
} from "./evaluationProvenance";
import type {
  EvaluationContext,
  EvaluationOrigin,
  EvaluationPathOrigin,
  EvaluationPathRange,
  EvaluationResult,
  EvaluationValue,
  EvaluationValueIssue,
  EvaluationValueIssueKind,
  LambdaValue
} from "./evaluationTypes";
import { isModuleNamespaceValue } from "./moduleNamespaceValue";
import { appendGeneratedPath } from "./sourcePaths";

interface EvaluationTraceFrame {
  expression: ExprNode;
  context: EvaluationContext;
  children: CompletedEvaluationTraceFrame[];
  collectionTrace?: CollectionEvaluationTrace;
}

interface CompletedEvaluationTraceFrame extends EvaluationTraceFrame {
  result: EvaluationResult;
}

/** Internal stack that observes the real evaluator without executing AST twice. */
export class EvaluationTraceSession {
  private readonly stack: EvaluationTraceFrame[] = [];
  private rootResult?: EvaluationResult;

  public enter(expression: ExprNode, context: EvaluationContext): EvaluationTraceFrame {
    const frame = { expression, context, children: [] };
    this.stack.push(frame);
    return frame;
  }

  public leave(frame: EvaluationTraceFrame, value: EvaluationValue): EvaluationResult {
    const active = this.stack.pop();
    if (active !== frame) {
      throw new Error("RSGL evaluation trace stack became unbalanced.");
    }
    const result = buildEvaluationResult(frame, value);
    const completed = { ...frame, result };
    const parent = this.stack[this.stack.length - 1];
    if (parent) {
      parent.children.push(completed);
    } else {
      this.rootResult = result;
    }
    return result;
  }

  public abort(frame: EvaluationTraceFrame): void {
    const active = this.stack.pop();
    if (active !== frame) {
      this.stack.length = 0;
    }
  }

  public latestChildResult(expression: ExprNode): EvaluationResult | undefined {
    const frame = this.stack[this.stack.length - 1];
    return [...(frame?.children ?? [])].reverse()
      .find(child => child.expression === expression)?.result;
  }

  public recordCollectionTrace(trace: CollectionEvaluationTrace): void {
    const frame = this.stack[this.stack.length - 1];
    if (frame) {
      frame.collectionTrace = trace;
    }
  }

  public result(): EvaluationResult | undefined {
    return this.rootResult;
  }
}

function buildEvaluationResult(
  frame: EvaluationTraceFrame,
  value: EvaluationValue
): EvaluationResult {
  const expression = frame.expression;
  const direct = directEvaluationResult(expression, value);

  if (expression.kind === "IdentifierExpr") {
    const pathOrigins = frame.context.valuePathOrigins?.get(expression.name.text)
      ?? (frame.context.valueOrigins?.get(expression.name.text)
        ? [{ generatedPath: "", ...frame.context.valueOrigins.get(expression.name.text)! }]
        : []);
    return evaluationResult(
      value,
      direct.pathRanges,
      pathOrigins,
      frame.context.valueIssues?.get(expression.name.text) ?? direct.valueIssues,
      direct.valuePathRanges,
      frame.context.valueSelectionPathOrigins?.get(expression.name.text) ?? []
    );
  }

  if (expression.kind === "TemplateStringExpr") {
    return evaluationResult(
      value,
      direct.pathRanges,
      [],
      [...direct.valueIssues, ...frame.children.flatMap(child => child.result.valueIssues)]
    );
  }

  if (expression.kind === "ListExpr") {
    if (frame.collectionTrace) {
      return tracedCollectionEvaluationResult(
        frame,
        value,
        expression.range,
        frame.collectionTrace
      );
    }
    return structuralEvaluationResult(
      value,
      expression.range,
      expression.elements.flatMap((element, index) => {
        const child = childForExpression(
          frame,
          element.kind === "ListSpread" ? element.expression : element
        );
        return child
          ? [rebaseEvaluationResult(child.result, appendGeneratedPath("", String(index)))]
          : [];
      })
    );
  }

  if (expression.kind === "ObjectExpr") {
    if (frame.collectionTrace) {
      return tracedCollectionEvaluationResult(
        frame,
        value,
        expression.range,
        frame.collectionTrace,
        tracedObjectKeyIssues(
          expression.properties.filter(isObjectPropertyNode),
          frame
        )
      );
    }
    const properties = expression.properties.filter(isObjectPropertyNode);
    const children: EvaluationResult[] = [];
    for (const property of properties) {
      const valueChild = childForExpression(frame, property.value);
      if (!valueChild) {
        continue;
      }
      const key = tracedPropertyKey(property, frame);
      if (key !== null) {
        children.push(rebaseEvaluationResult(
          valueChild.result,
          appendGeneratedPath("", key)
        ));
      }
    }
    return structuralEvaluationResult(
      value,
      expression.range,
      children,
      tracedObjectKeyIssues(properties, frame)
    );
  }

  if (expression.kind === "MemberExpr") {
    const object = childForExpression(frame, expression.object);
    if (object && isModuleNamespaceValue(object.result.value)) {
      const member = object.result.value.resolveValue(expression.property.text);
      const pathOrigins = member?.pathOrigins.length
        ? member.pathOrigins
        : member?.origin
          ? [{ generatedPath: "", ...member.origin }]
          : [];
      return evaluationResult(
        value,
        [{ generatedPath: "", sourceRange: expression.range }],
        pathOrigins,
        member?.valueIssues ?? direct.valueIssues,
        direct.valuePathRanges,
        member?.selectionPathOrigins ?? []
      );
    }
    return object
      ? selectedEvaluationResult(
        value,
        expression.range,
        object.result,
        appendGeneratedPath("", expression.property.text)
      )
      : direct;
  }

  if (expression.kind === "IndexExpr") {
    const object = childForExpression(frame, expression.object);
    const index = childForExpression(frame, expression.index);
    const key = scalarText(index?.result.value);
    return object && key !== null
      ? selectedEvaluationResult(
        value,
        expression.range,
        object.result,
        appendGeneratedPath("", key)
      )
      : direct;
  }

  if (expression.kind === "ConditionalExpr") {
    const selected = frame.children.find(child =>
      child.expression === expression.whenTrue || child.expression === expression.whenFalse
    );
    return selected
      ? wrappedEvaluationResult(value, expression.range, selected.result)
      : direct;
  }

  if (expression.kind === "MatchExpr") {
    const armValues = new Set(expression.arms.map(arm => arm.value));
    const selected = [...frame.children].reverse()
      .find(child => armValues.has(child.expression));
    return selected
      ? wrappedEvaluationResult(value, expression.range, selected.result)
      : direct;
  }

  if (expression.kind === "ForInExpr") {
    const iterable = childForExpression(frame, expression.iterable);
    return iterable
      ? wrappedEvaluationResult(value, expression.range, iterable.result)
      : direct;
  }

  if (expression.kind === "CallExpr") {
    if (frame.collectionTrace) {
      return tracedCollectionEvaluationResult(
        frame,
        value,
        expression.range,
        frame.collectionTrace
      );
    }
    if (expression.callee.kind === "IdentifierExpr" && expression.callee.name.text === "seq") {
      const childOrigins = frame.children.flatMap(child =>
        materializeEvaluationPathOrigins(child.result, child.context.sourceFile)
      );
      const origin = mergeEvaluationOrigins(childOrigins);
      return evaluationResult(
        value,
        direct.pathRanges,
        origin ? [{ generatedPath: "", ...origin }] : [],
        direct.valueIssues
      );
    }
    if (
      expression.callee.kind === "IdentifierExpr"
      && isRsglResourceIdConstructorName(expression.callee.name.text)
    ) {
      const argument = expression.args[0]
        ? childForExpression(frame, expression.args[0].value)
        : undefined;
      if (argument) {
        return evaluationResult(
          value,
          argument.result.pathRanges,
          materializeEvaluationPathOrigins(argument.result, argument.context.sourceFile),
          materializeEvaluationValueIssues(argument.result, argument.context.sourceFile),
          argument.result.valuePathRanges,
          materializeEvaluationSelectionPathOrigins(
            argument.result,
            argument.context.sourceFile
          )
        );
      }
    }
    const callee = childForExpression(frame, expression.callee);
    const calleeValue = callee?.result.value;
    if (isLambdaLikeValue(calleeValue)) {
      const lambda = calleeValue as LambdaValue;
      const body = [...frame.children].reverse()
        .find(child => child.expression === lambda.body);
      if (body) {
        const pathOrigins = materializeEvaluationPathOrigins(
          body.result,
          body.context.sourceFile
        );
        return evaluationResult(
          value,
          [{ generatedPath: "", sourceRange: expression.range }],
          pathOrigins,
          materializeEvaluationValueIssues(body.result, body.context.sourceFile),
          body.result.valuePathRanges,
          materializeEvaluationSelectionPathOrigins(body.result, body.context.sourceFile)
        );
      }
    }
    const childOrigins = frame.children.flatMap(child =>
      materializeEvaluationPathOrigins(child.result, child.context.sourceFile)
    );
    const origin = mergeEvaluationOrigins(childOrigins);
    const retainedIssues = expression.callee.kind === "IdentifierExpr"
      && expression.callee.name.text === "product"
      ? frame.children.flatMap(child =>
        materializeEvaluationValueIssues(child.result, child.context.sourceFile)
      )
      : [];
    return evaluationResult(
      value,
      direct.pathRanges,
      origin ? [{ generatedPath: "", ...origin }] : [],
      [...direct.valueIssues, ...retainedIssues]
    );
  }

  const inherited = frame.children.flatMap(child => child.result.pathOrigins);
  const origin = mergeEvaluationOrigins(inherited);
  return evaluationResult(
    value,
    direct.pathRanges,
    origin ? [{ generatedPath: "", ...origin }] : [],
    [...direct.valueIssues, ...frame.children.flatMap(child => child.result.valueIssues)]
  );
}

export function directEvaluationResult(
  expression: ExprNode,
  value: EvaluationValue
): EvaluationResult {
  const kind: EvaluationValueIssueKind | undefined = value === undefined
    ? "undefined"
    : isLambdaLikeValue(value)
      ? "lambda"
      : typeof value === "number" && !Number.isFinite(value)
        ? "nonFiniteNumber"
        : undefined;
  return evaluationResult(
    value,
    [{ generatedPath: "", sourceRange: expression.range }],
    [],
    kind ? [{ generatedPath: "", kind, sourceRange: expression.range }] : []
  );
}

function structuralEvaluationResult(
  value: EvaluationValue,
  range: TextRange,
  children: readonly EvaluationResult[],
  additionalIssues: readonly EvaluationValueIssue[] = []
): EvaluationResult {
  const pathRanges = deduplicatePathEntries([
    { generatedPath: "", sourceRange: range },
    ...children.flatMap(child => child.pathRanges)
  ]);
  return evaluationResult(
    value,
    pathRanges,
    deduplicatePathEntries(children.flatMap(child => child.pathOrigins)),
    deduplicateValueIssues([
      ...children.flatMap(child => child.valueIssues),
      ...additionalIssues
    ]),
    deduplicatePathEntries([
      { generatedPath: "", sourceRange: range },
      ...children.flatMap(child => child.valuePathRanges)
    ]),
    deduplicatePathEntries(children.flatMap(child => child.selectionPathOrigins))
  );
}

function tracedCollectionEvaluationResult(
  frame: EvaluationTraceFrame,
  value: EvaluationValue,
  range: TextRange,
  trace: CollectionEvaluationTrace,
  additionalIssues: readonly EvaluationValueIssue[] = []
): EvaluationResult {
  const children = trace.paths.map(path => {
    const selected = path.source.selectedPath === undefined
      ? path.source.result
      : selectEvaluationResultPath(path.source.result, path.source.selectedPath);
    const sourceFile = path.source.sourceFile;
    const durable = evaluationResult(
      selected.value,
      sourceFile === frame.context.sourceFile ? selected.pathRanges : [],
      materializeEvaluationPathOrigins(selected, sourceFile),
      path.source.omitValueIssues
        ? []
        : materializeEvaluationValueIssues(selected, sourceFile),
      sourceFile === frame.context.sourceFile ? selected.valuePathRanges : [],
      materializeEvaluationSelectionPathOrigins(selected, sourceFile)
    );
    return rebaseEvaluationResult(durable, path.outputPath);
  });
  return structuralEvaluationResult(value, range, children, [
    ...additionalIssues,
    ...(trace.stateRecordKeyIssues ?? [])
  ]);
}

function wrappedEvaluationResult(
  value: EvaluationValue,
  range: TextRange,
  selected: EvaluationResult
): EvaluationResult {
  const ranges = selected.pathRanges.filter(item => item.generatedPath !== "");
  return evaluationResult(
    value,
    [{ generatedPath: "", sourceRange: range }, ...ranges],
    selected.pathOrigins,
    selected.valueIssues,
    selected.valuePathRanges,
    selected.selectionPathOrigins
  );
}

function selectedEvaluationResult(
  value: EvaluationValue,
  range: TextRange,
  source: EvaluationResult,
  selectedPath: string
): EvaluationResult {
  const selected = selectEvaluationResultPath(source, selectedPath);
  return evaluationResult(
    value,
    [
      { generatedPath: "", sourceRange: range },
      ...selected.pathRanges.filter(item => item.generatedPath !== "")
    ],
    selected.pathOrigins,
    selected.valueIssues,
    selected.valuePathRanges,
    selected.selectionPathOrigins
  );
}

function evaluationResult(
  value: EvaluationValue,
  pathRanges: readonly EvaluationPathRange[],
  pathOrigins: readonly EvaluationPathOrigin[],
  valueIssues: readonly EvaluationValueIssue[] = [],
  valuePathRanges: readonly EvaluationPathRange[] = pathRanges,
  selectionPathOrigins: readonly EvaluationPathOrigin[] = []
): EvaluationResult {
  const origins = deduplicatePathEntries(pathOrigins);
  const origin = originForEvaluationPath(origins, "") ?? mergeEvaluationOrigins(origins);
  const rootRange = rangeForEvaluationPath(pathRanges, "") ?? { start: 0, end: 0 };
  const intrinsicKind: EvaluationValueIssueKind | undefined = value === undefined
    ? "undefined"
    : isLambdaLikeValue(value)
      ? "lambda"
      : typeof value === "number" && !Number.isFinite(value)
        ? "nonFiniteNumber"
        : undefined;
  return {
    value,
    ...(origin ? { origin } : {}),
    pathOrigins: origins,
    selectionPathOrigins: deduplicatePathEntries(selectionPathOrigins),
    valuePathRanges: deduplicatePathEntries(valuePathRanges),
    pathRanges: deduplicatePathEntries(pathRanges),
    valueIssues: deduplicateValueIssues([
      ...valueIssues,
      ...(intrinsicKind
        ? [{ generatedPath: "", kind: intrinsicKind, sourceRange: rootRange }]
        : [])
    ])
  };
}

function rebaseEvaluationResult(
  result: EvaluationResult,
  basePath: string
): EvaluationResult {
  return evaluationResult(
    result.value,
    result.pathRanges.map(item => ({
      ...item,
      generatedPath: appendEvaluationPath(basePath, item.generatedPath)
    })),
    result.pathOrigins.map(item => ({
      ...item,
      generatedPath: appendEvaluationPath(basePath, item.generatedPath)
    })),
    result.valueIssues.map(item => ({
      ...item,
      generatedPath: appendEvaluationPath(basePath, item.generatedPath)
    })),
    result.valuePathRanges.map(item => ({
      ...item,
      generatedPath: appendEvaluationPath(basePath, item.generatedPath)
    })),
    result.selectionPathOrigins.map(item => ({
      ...item,
      generatedPath: appendEvaluationPath(basePath, item.generatedPath)
    }))
  );
}

export function selectEvaluationResultPath(
  result: EvaluationResult,
  selectedPath: string
): EvaluationResult {
  const ranges = selectPathEntries(result.pathRanges, selectedPath);
  const valueRanges = selectPathEntries(result.valuePathRanges, selectedPath);
  const origins = selectPathEntries(result.pathOrigins, selectedPath);
  const selectionOrigins = selectPathEntries(result.selectionPathOrigins, selectedPath);
  const inheritedRange = rangeForEvaluationPath(result.pathRanges, selectedPath);
  const inheritedValueRange = rangeForEvaluationPath(result.valuePathRanges, selectedPath);
  const inheritedOrigin = originForEvaluationPath(result.pathOrigins, selectedPath);
  const inheritedSelectionOrigin = originForEvaluationPath(
    result.selectionPathOrigins,
    selectedPath
  );
  return evaluationResult(
    result.value,
    ranges.length > 0
      ? ranges
      : inheritedRange ? [{ generatedPath: "", sourceRange: inheritedRange }] : [],
    origins.length > 0
      ? origins
      : inheritedOrigin ? [{ generatedPath: "", ...inheritedOrigin }] : [],
    selectPathEntries(result.valueIssues, selectedPath),
    valueRanges.length > 0
      ? valueRanges
      : inheritedValueRange
        ? [{ generatedPath: "", sourceRange: inheritedValueRange }]
        : [],
    selectionOrigins.length > 0
      ? selectionOrigins
      : inheritedSelectionOrigin
        ? [{ generatedPath: "", ...inheritedSelectionOrigin }]
        : []
  );
}

function appendEvaluationPath(basePath: string, childPath: string): string {
  return childPath ? `${basePath}${childPath}` : basePath;
}

function childForExpression(
  frame: EvaluationTraceFrame,
  expression: ExprNode
): CompletedEvaluationTraceFrame | undefined {
  return [...frame.children].reverse().find(child => child.expression === expression);
}

function tracedPropertyKey(
  property: ObjectPropertyNode,
  frame: EvaluationTraceFrame
): string | null {
  const staticName = staticPropertyKeyName(property.key);
  if (staticName !== undefined) {
    return staticName;
  }
  if (property.key.kind !== "DynamicKey") {
    return null;
  }
  const child = childForExpression(frame, property.key.expression);
  return scalarText(child?.result.value);
}

function tracedObjectKeyIssues(
  properties: readonly ObjectPropertyNode[],
  frame: EvaluationTraceFrame
): EvaluationValueIssue[] {
  const issues: EvaluationValueIssue[] = [];
  const seen = new Set<string>();
  for (const property of properties) {
    const key = tracedPropertyKey(property, frame);
    if (key === null) {
      issues.push({
        generatedPath: "",
        kind: "invalidObjectKey",
        sourceRange: property.key.range
      });
      continue;
    }
    const generatedPath = appendGeneratedPath("", key);
    if (seen.has(key)) {
      issues.push({
        generatedPath,
        kind: "duplicateObjectKey",
        sourceRange: property.key.range
      });
    }
    seen.add(key);
  }
  return issues;
}

function mergeEvaluationOrigins(
  values: readonly (EvaluationOrigin | undefined)[]
): EvaluationOrigin | undefined {
  const origins = values.filter((value): value is EvaluationOrigin => value !== undefined);
  if (origins.length === 0) {
    return undefined;
  }
  const first = origins[0];
  if (origins.every(origin =>
    origin.sourceFile === first.sourceFile
    && origin.sourceRange.start === first.sourceRange.start
    && origin.sourceRange.end === first.sourceRange.end
  )) {
    return { sourceFile: first.sourceFile, sourceRange: first.sourceRange };
  }
  if (origins.every(origin => origin.sourceFile === first.sourceFile)) {
    return {
      sourceFile: first.sourceFile,
      sourceRange: {
        start: Math.min(...origins.map(origin => origin.sourceRange.start)),
        end: Math.max(...origins.map(origin => origin.sourceRange.end))
      }
    };
  }
  return undefined;
}

function isObjectPropertyNode(value: unknown): value is ObjectPropertyNode {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { kind?: string }).kind === "ObjectProperty"
  );
}

function scalarText(value: EvaluationValue): string | null {
  return evaluationScalarText(value);
}
