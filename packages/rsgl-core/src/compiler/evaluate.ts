import {
  ExprNode,
  ListElementNode,
  ObjectEntryNode,
  ObjectPropertyNode,
  TextRange
} from "../parser";
import { bindRsglArgumentSlots } from "../arguments";
import { tryParseMinecraftResourceId } from "../../../mc-assets/src";
import { builtinEffect, getBuiltinSignature } from "../semantic/builtins";
import { findLambdaImpureCalls, LambdaImpureCall } from "../semantic/lambdaPurity";
import type { RsglType } from "../semantic/types";
import {
  isRsglResourceIdConstructorName,
  rsglResourceIdConstructors,
  typeKindForResourceValueKind
} from "../resourceIdSemantics";
import { isJsonObject, normalizeJsonValue } from "./compilerHelpers";
import {
  contextualResourceKinds,
  contextualizeEvaluatedValue
} from "./contextualResourceValueConversion";
import {
  createEvaluatedResourceId,
  evaluationScalarText,
  isEvaluatedResourceId,
  isEvaluatedResourceValue,
  type RsglEvaluatedResourceValue
} from "./evaluatedResourceValues";
import { ExpansionFrame, JsonValue, RsglMapping } from "./ir";
import type { BaseDocumentLoader, CompileDependency } from "./base/types";
import {
  type CollectionEvaluationTrace,
  type CollectionLambdaArgument,
  evaluateCollectionBuiltin
} from "./collectionBuiltins";
import {
  EvaluationItemBudget,
  MAX_EVALUATION_ITEMS_PER_ALLOCATION
} from "./evaluationItemBudget";
import {
  createJsonObject,
  jsonObjectEntries,
  jsonObjectKeys,
  setJsonObjectProperty
} from "./jsonObjectProperties";
import {
  expandSequencePattern,
  formatSequenceNumber,
  sequencePadWidth,
  sequencePatternExpansionCount
} from "./sequences";
import { appendGeneratedPath } from "./sourcePaths";

export interface LambdaValue {
  kind: "lambda";
  parameters: string[];
  body: ExprNode;
  context: EvaluationContext;
  /** Contextual function type retained for runtime argument/return boundaries. */
  signature?: {
    parameters: readonly RsglType[];
    returnType: RsglType;
  };
  /** Impure builtin calls found in the body; a non-empty list blocks execution. */
  impureCalls: LambdaImpureCall[];
}

export type EvaluationValue = JsonValue | RsglEvaluatedResourceValue | LambdaValue | undefined;

export interface RawGlobLoadLimits {
  /** Maximum result items the current shared evaluation budget can accept. */
  maxMatches: number;
  /** Maximum filesystem entries a synchronous loader may inspect. */
  maxVisitedEntries: number;
}

export interface RawGlobLimitExceeded {
  kind: "limitExceeded";
}

export type RawGlobLoadResult = string[] | RawGlobLimitExceeded | undefined;
export type RawGlobLoader = (
  pattern: string,
  context: EvaluationContext,
  range: TextRange,
  limits?: RawGlobLoadLimits
) => RawGlobLoadResult;

export interface EvaluationOrigin {
  sourceFile: string;
  sourceRange: TextRange;
}

export interface EvaluationPathOrigin extends EvaluationOrigin {
  generatedPath: string;
}

/** Source ranges inside the expression currently being evaluated. */
export interface EvaluationPathRange {
  generatedPath: string;
  sourceRange: TextRange;
}

export type EvaluationValueIssueKind =
  | "undefined"
  | "lambda"
  | "nonFiniteNumber"
  | "duplicateObjectKey"
  | "invalidObjectKey";

/** Runtime value-shape facts captured without evaluating an expression twice. */
export interface EvaluationValueIssue {
  generatedPath: string;
  kind: EvaluationValueIssueKind;
  sourceRange: TextRange;
  sourceFile?: string;
}

/**
 * One evaluation plus the provenance needed by JSON-path-aware lowerers.
 *
 * `pathRanges` describe syntax in the current expression. `pathOrigins`
 * describe values inherited through a binding/call. Keeping the two layers
 * separate lets source maps point at a local member/call while validation can
 * still jump to the argument or definition that produced an individual field.
 */
export interface EvaluationResult {
  value: EvaluationValue;
  origin?: EvaluationOrigin;
  pathOrigins: EvaluationPathOrigin[];
  pathRanges: EvaluationPathRange[];
  valueIssues: EvaluationValueIssue[];
}

export interface EvaluationContext {
  namespace: string;
  variables: Map<string, EvaluationValue>;
  /** Shared collection-expansion accounting for the current compile run. */
  evaluationItemBudget?: EvaluationItemBudget;
  /** Semantic contextual-type facts for AST nodes owned by this module. */
  resolvedExpectedTypes?: ReadonlyMap<ExprNode, RsglType>;
  /** Lexically bound value names, including predeclared bindings not evaluated yet. */
  valueBindingNames?: ReadonlySet<string>;
  /** Lexical origins of values bound from template call arguments. */
  valueOrigins?: ReadonlyMap<string, EvaluationOrigin>;
  /** JSON-pointer-level origins for structured lexical values. */
  valuePathOrigins?: ReadonlyMap<string, readonly EvaluationPathOrigin[]>;
  /** Runtime value-shape issues retained across lexical bindings. */
  valueIssues?: ReadonlyMap<string, readonly EvaluationValueIssue[]>;
  stateKeyAliases?: ReadonlySet<string>;
  sourceFile?: string;
  mappingReason?: RsglMapping["reason"];
  expansionStack?: ExpansionFrame[];
  baseDocumentLoader?: BaseDocumentLoader;
  globLoader?: RawGlobLoader;
  onDependency?: (dependency: CompileDependency) => void;
  onError?: (code: string, message: string, range: TextRange, fileName?: string) => void;
  /** @internal Signals that evaluation failed even when semantic analysis owns the diagnostic. */
  onEvaluationFailure?: () => void;
  /** @internal Marks a typed resource-value failure as fatal for the enclosing resource transaction. */
  onResourceValueFailure?: () => void;
  /** @internal Active only for one evaluateExpressionResult call. */
  evaluationTrace?: EvaluationTraceSession;
}

/** Binds a value and its lexical origin without mutating a parent context's origin map. */
export function bindEvaluationValue(
  context: EvaluationContext,
  name: string,
  value: EvaluationValue,
  origin?: EvaluationOrigin,
  pathOrigins: readonly EvaluationPathOrigin[] = [],
  valueIssues: readonly EvaluationValueIssue[] = []
): void {
  context.variables.set(name, value);
  context.valueBindingNames = new Set([...(context.valueBindingNames ?? []), name]);
  const origins = new Map(context.valueOrigins ?? []);
  if (origin) {
    origins.set(name, origin);
  } else {
    origins.delete(name);
  }
  context.valueOrigins = origins;
  const originsByName = new Map(context.valuePathOrigins ?? []);
  if (pathOrigins.length > 0) {
    originsByName.set(name, [...pathOrigins]);
  } else {
    originsByName.delete(name);
  }
  context.valuePathOrigins = originsByName;
  const issuesByName = new Map(context.valueIssues ?? []);
  if (valueIssues.length > 0) {
    issuesByName.set(name, [...valueIssues]);
  } else {
    issuesByName.delete(name);
  }
  context.valueIssues = issuesByName;
}

/** Binds a traced result, materializing direct ranges in the binding's file. */
export function bindEvaluationResult(
  context: EvaluationContext,
  name: string,
  result: EvaluationResult,
  sourceFile = context.sourceFile
): void {
  const pathOrigins = materializeEvaluationPathOrigins(result, sourceFile);
  bindEvaluationValue(
    context,
    name,
    result.value,
    originForEvaluationPath(pathOrigins, "") ?? result.origin,
    pathOrigins,
    materializeEvaluationValueIssues(result, sourceFile)
  );
}

export function materializeEvaluationValueIssues(
  result: Pick<EvaluationResult, "valueIssues">,
  sourceFile?: string
): EvaluationValueIssue[] {
  return result.valueIssues.map(issue => ({
    ...issue,
    ...(issue.sourceFile || !sourceFile ? {} : { sourceFile })
  }));
}

/** True when a value binding shadows a same-named template or builtin helper. */
export function hasEvaluationValueBinding(context: EvaluationContext, name: string): boolean {
  return context.variables.has(name) || Boolean(context.valueBindingNames?.has(name));
}

/** Returns the most specific provenance at `generatedPath`. */
export function originForEvaluationPath(
  origins: readonly EvaluationPathOrigin[],
  generatedPath: string
): EvaluationOrigin | undefined {
  const origin = mostSpecificPathEntry(origins, generatedPath);
  return origin ? { sourceFile: origin.sourceFile, sourceRange: origin.sourceRange } : undefined;
}

/** Returns the most specific direct syntax range at `generatedPath`. */
export function rangeForEvaluationPath(
  ranges: readonly EvaluationPathRange[],
  generatedPath: string
): TextRange | undefined {
  return mostSpecificPathEntry(ranges, generatedPath)?.sourceRange;
}

/** Selects a structured value path and rebases it to the result root. */
export function selectEvaluationPathOrigins(
  origins: readonly EvaluationPathOrigin[],
  selectedPath: string
): EvaluationPathOrigin[] {
  const selected = selectPathEntries(origins, selectedPath);
  if (selected.length > 0) {
    return selected;
  }
  const inherited = originForEvaluationPath(origins, selectedPath);
  return inherited ? [{ generatedPath: "", ...inherited }] : [];
}

/** Selects value-shape issues below a JSON pointer and rebases them to the selected value. */
export function selectEvaluationValueIssues(
  issues: readonly EvaluationValueIssue[],
  selectedPath: string
): EvaluationValueIssue[] {
  return selectPathEntries(issues, selectedPath);
}

/**
 * Converts direct syntax ranges to durable origins for a lexical binding.
 * An inherited origin wins at the same path (or an ancestor), so wrapping a
 * caller value in an identifier/conditional never replaces caller provenance
 * with the wrapper's definition range.
 */
export function materializeEvaluationPathOrigins(
  result: Pick<EvaluationResult, "pathOrigins" | "pathRanges">,
  sourceFile?: string
): EvaluationPathOrigin[] {
  const inheritedOrigins = deduplicatePathEntries(result.pathOrigins);
  if (!sourceFile) {
    return inheritedOrigins;
  }
  const origins = [...inheritedOrigins];
  for (const item of result.pathRanges) {
    if (!originForEvaluationPath(inheritedOrigins, item.generatedPath)) {
      origins.push({
        generatedPath: item.generatedPath,
        sourceFile,
        sourceRange: item.sourceRange
      });
    }
  }
  return deduplicatePathEntries(origins);
}

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
class EvaluationTraceSession {
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
        ? [{
            generatedPath: "",
            ...frame.context.valueOrigins.get(expression.name.text)!
          }]
        : []);
    return evaluationResult(
      value,
      direct.pathRanges,
      pathOrigins,
      frame.context.valueIssues?.get(expression.name.text) ?? direct.valueIssues
    );
  }

  if (expression.kind === "TemplateStringExpr") {
    // Interpolation constructs one new scalar value. Its root provenance is
    // therefore the complete template-string expression, not the origin of an
    // interpolated binding. Child failures still belong to the constructed
    // value and must survive binding/template expansion.
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
        return child ? [rebaseEvaluationResult(child.result, appendGeneratedPath("", String(index)))] : [];
      })
    );
  }

  if (expression.kind === "ObjectExpr" || expression.kind === "StateKeySugar") {
    if (expression.kind === "ObjectExpr" && frame.collectionTrace) {
      return tracedCollectionEvaluationResult(
        frame,
        value,
        expression.range,
        frame.collectionTrace,
        tracedObjectKeyIssues(
          expression.properties.filter(isObjectPropertyNode),
          false,
          frame
        )
      );
    }
    const properties = expression.kind === "ObjectExpr"
      ? expression.properties.filter(isObjectPropertyNode)
      : expression.entries;
    const children: EvaluationResult[] = [];
    for (const property of properties) {
      const valueChild = childForExpression(frame, property.value);
      if (!valueChild) {
        continue;
      }
      const key = tracedPropertyKey(property, expression.kind === "StateKeySugar", frame);
      if (key !== null) {
        children.push(rebaseEvaluationResult(valueChild.result, appendGeneratedPath("", key)));
      }
    }
    return structuralEvaluationResult(
      value,
      expression.range,
      children,
      tracedObjectKeyIssues(properties, expression.kind === "StateKeySugar", frame)
    );
  }

  if (expression.kind === "ModelApplySugar") {
    const children: EvaluationResult[] = [];
    const model = childForExpression(frame, expression.model);
    if (model) {
      children.push(rebaseEvaluationResult(model.result, "/model"));
    }
    for (const property of expression.properties) {
      const child = childForExpression(frame, property.value);
      if (child) {
        children.push(rebaseEvaluationResult(
          child.result,
          appendGeneratedPath("", property.name.text)
        ));
      }
    }
    return structuralEvaluationResult(value, expression.range, children);
  }

  if (expression.kind === "RandomApply") {
    return structuralEvaluationResult(
      value,
      expression.range,
      expression.entries.flatMap((entry, index) => {
        const child = childForExpression(frame, entry);
        return child ? [rebaseEvaluationResult(child.result, appendGeneratedPath("", String(index)))] : [];
      })
    );
  }

  if (expression.kind === "MemberExpr") {
    const object = childForExpression(frame, expression.object);
    return object
      ? selectedEvaluationResult(value, expression.range, object.result, appendGeneratedPath("", expression.property.text))
      : direct;
  }

  if (expression.kind === "IndexExpr") {
    const object = childForExpression(frame, expression.object);
    const index = childForExpression(frame, expression.index);
    const key = scalarText(index?.result.value);
    return object && key !== null
      ? selectedEvaluationResult(value, expression.range, object.result, appendGeneratedPath("", key))
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
    const selected = [...frame.children].reverse().find(child => armValues.has(child.expression));
    return selected
      ? wrappedEvaluationResult(value, expression.range, selected.result)
      : direct;
  }

  if (expression.kind === "ForInExpr") {
    const iterable = childForExpression(frame, expression.iterable);
    return iterable ? wrappedEvaluationResult(value, expression.range, iterable.result) : direct;
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
          materializeEvaluationValueIssues(argument.result, argument.context.sourceFile)
        );
      }
    }
    const callee = childForExpression(frame, expression.callee);
    const calleeValue = callee?.result.value;
    if (isLambdaValue(calleeValue)) {
      const body = [...frame.children].reverse()
        .find(child => child.expression === calleeValue.body);
      if (body) {
        const pathOrigins = materializeEvaluationPathOrigins(body.result, body.context.sourceFile);
        return evaluationResult(
          value,
          [{ generatedPath: "", sourceRange: expression.range }],
          pathOrigins,
          materializeEvaluationValueIssues(body.result, body.context.sourceFile)
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
      [
        ...direct.valueIssues,
        ...retainedIssues
      ]
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

function directEvaluationResult(expression: ExprNode, value: EvaluationValue): EvaluationResult {
  const kind: EvaluationValueIssueKind | undefined = value === undefined
    ? "undefined"
    : isLambdaValue(value)
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
  return evaluationResult(
    value,
    deduplicatePathEntries([
      { generatedPath: "", sourceRange: range },
      ...children.flatMap(child => child.pathRanges)
    ]),
    deduplicatePathEntries(children.flatMap(child => child.pathOrigins)),
    deduplicateValueIssues([
      ...children.flatMap(child => child.valueIssues),
      ...additionalIssues
    ])
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
        : materializeEvaluationValueIssues(selected, sourceFile)
    );
    return rebaseEvaluationResult(durable, path.outputPath);
  });
  return structuralEvaluationResult(value, range, children, additionalIssues);
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
    selected.valueIssues
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
    [{ generatedPath: "", sourceRange: range }, ...selected.pathRanges.filter(item => item.generatedPath !== "")],
    selected.pathOrigins,
    selected.valueIssues
  );
}

function evaluationResult(
  value: EvaluationValue,
  pathRanges: readonly EvaluationPathRange[],
  pathOrigins: readonly EvaluationPathOrigin[],
  valueIssues: readonly EvaluationValueIssue[] = []
): EvaluationResult {
  const origins = deduplicatePathEntries(pathOrigins);
  const origin = originForEvaluationPath(origins, "") ?? mergeEvaluationOrigins(origins);
  const rootRange = rangeForEvaluationPath(pathRanges, "") ?? { start: 0, end: 0 };
  const intrinsicKind: EvaluationValueIssueKind | undefined = value === undefined
    ? "undefined"
    : isLambdaValue(value)
      ? "lambda"
      : typeof value === "number" && !Number.isFinite(value)
        ? "nonFiniteNumber"
        : undefined;
  return {
    value,
    ...(origin ? { origin } : {}),
    pathOrigins: origins,
    pathRanges: deduplicatePathEntries(pathRanges),
    valueIssues: deduplicateValueIssues([
      ...valueIssues,
      ...(intrinsicKind
        ? [{ generatedPath: "", kind: intrinsicKind, sourceRange: rootRange }]
        : [])
    ])
  };
}

function rebaseEvaluationResult(result: EvaluationResult, basePath: string): EvaluationResult {
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
    }))
  );
}

function selectEvaluationResultPath(result: EvaluationResult, selectedPath: string): EvaluationResult {
  const ranges = selectPathEntries(result.pathRanges, selectedPath);
  const origins = selectPathEntries(result.pathOrigins, selectedPath);
  const inheritedRange = rangeForEvaluationPath(result.pathRanges, selectedPath);
  const inheritedOrigin = originForEvaluationPath(result.pathOrigins, selectedPath);
  return evaluationResult(
    result.value,
    ranges.length > 0
      ? ranges
      : inheritedRange ? [{ generatedPath: "", sourceRange: inheritedRange }] : [],
    origins.length > 0
      ? origins
      : inheritedOrigin ? [{ generatedPath: "", ...inheritedOrigin }] : [],
    selectPathEntries(result.valueIssues, selectedPath)
  );
}

function selectPathEntries<T extends { generatedPath: string }>(
  entries: readonly T[],
  selectedPath: string
): T[] {
  return entries
    .filter(item => item.generatedPath === selectedPath || item.generatedPath.startsWith(`${selectedPath}/`))
    .map(item => ({
      ...item,
      generatedPath: item.generatedPath.slice(selectedPath.length)
    }));
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
  stateKey: boolean,
  frame: EvaluationTraceFrame
): string | null {
  if (property.key.kind === "Identifier") {
    if (stateKey && frame.context.stateKeyAliases?.has(property.key.text)) {
      return scalarText(frame.context.variables.get(property.key.text)) ?? property.key.text;
    }
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  if (property.key.kind === "NumberLiteral") {
    return property.key.raw;
  }
  const child = childForExpression(frame, property.key.expression);
  const value = child?.result.value;
  return scalarText(value);
}

function tracedObjectKeyIssues(
  properties: readonly ObjectPropertyNode[],
  stateKey: boolean,
  frame: EvaluationTraceFrame
): EvaluationValueIssue[] {
  const issues: EvaluationValueIssue[] = [];
  const seen = new Set<string>();
  for (const property of properties) {
    const key = tracedPropertyKey(property, stateKey, frame);
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

function mostSpecificPathEntry<T extends { generatedPath: string }>(
  entries: readonly T[],
  generatedPath: string
): T | undefined {
  return entries
    .filter(item => item.generatedPath === generatedPath || (
      item.generatedPath === "" || generatedPath.startsWith(`${item.generatedPath}/`)
    ))
    .sort((left, right) => right.generatedPath.length - left.generatedPath.length)[0];
}

function deduplicatePathEntries<T extends { generatedPath: string }>(entries: readonly T[]): T[] {
  const byPath = new Map<string, T>();
  for (const entry of entries) {
    byPath.set(entry.generatedPath, entry);
  }
  return [...byPath.values()];
}

function deduplicateValueIssues(issues: readonly EvaluationValueIssue[]): EvaluationValueIssue[] {
  const byIdentity = new Map<string, EvaluationValueIssue>();
  for (const issue of issues) {
    byIdentity.set(JSON.stringify([
      issue.generatedPath,
      issue.kind,
      issue.sourceFile ?? "",
      issue.sourceRange.start,
      issue.sourceRange.end
    ]), issue);
  }
  return [...byIdentity.values()];
}

const builtinValues = new Map<string, JsonValue>([
  ["HORIZONTAL", ["north", "east", "south", "west"]],
  ["DIRECTIONS", ["down", "up", "north", "south", "west", "east"]],
  ["STAIR_SHAPES", ["straight", "inner_left", "inner_right", "outer_left", "outer_right"]],
  ["COLORS_16", [
    "white",
    "orange",
    "magenta",
    "light_blue",
    "yellow",
    "lime",
    "pink",
    "gray",
    "light_gray",
    "cyan",
    "purple",
    "blue",
    "brown",
    "green",
    "red",
    "black"
  ]]
]);

const horizontalYaw: Record<string, number> = {
  north: 0,
  east: 90,
  south: 180,
  west: 270
};

interface SeqGenerator {
  name: string;
  iterable: ExprNode;
}

export function expressionEvaluationOrigin(
  expression: ExprNode,
  context: EvaluationContext
): EvaluationOrigin | undefined {
  if (expression.kind === "IdentifierExpr") {
    return context.valueOrigins?.get(expression.name.text);
  }
  if (expression.kind === "TemplateStringExpr") {
    return mergeEvaluationOrigins(expression.parts.flatMap(part =>
      part.kind === "expression" ? [expressionEvaluationOrigin(part.expression, context)] : []
    ));
  }
  if (expression.kind === "ListExpr") {
    return mergeEvaluationOrigins(expression.elements.map(element =>
      expressionEvaluationOrigin(
        element.kind === "ListSpread" ? element.expression : element,
        context
      )
    ));
  }
  if (expression.kind === "ObjectExpr" || expression.kind === "StateKeySugar") {
    const properties = expression.kind === "ObjectExpr" ? expression.properties : expression.entries;
    return mergeEvaluationOrigins(properties.flatMap(property => {
      if (property.kind === "ObjectSpread") {
        return [expressionEvaluationOrigin(property.expression, context)];
      }
      return [
        property.key.kind === "DynamicKey" ? expressionEvaluationOrigin(property.key.expression, context) : undefined,
        expressionEvaluationOrigin(property.value, context)
      ];
    }));
  }
  if (expression.kind === "ModelApplySugar") {
    return mergeEvaluationOrigins([
      expressionEvaluationOrigin(expression.model, context),
      ...expression.properties.map(property => expressionEvaluationOrigin(property.value, context))
    ]);
  }
  if (expression.kind === "RandomApply") {
    return mergeEvaluationOrigins(expression.entries.map(entry => expressionEvaluationOrigin(entry, context)));
  }
  if (expression.kind === "RangeExpr") {
    return mergeEvaluationOrigins([
      expressionEvaluationOrigin(expression.startExpr, context),
      expressionEvaluationOrigin(expression.endExpr, context)
    ]);
  }
  if (expression.kind === "MemberExpr") {
    return expressionEvaluationOrigin(expression.object, context);
  }
  if (expression.kind === "IndexExpr") {
    return mergeEvaluationOrigins([
      expressionEvaluationOrigin(expression.object, context),
      expressionEvaluationOrigin(expression.index, context)
    ]);
  }
  if (expression.kind === "UnaryExpr") {
    return expressionEvaluationOrigin(expression.operand, context);
  }
  if (expression.kind === "BinaryExpr") {
    return mergeEvaluationOrigins([
      expressionEvaluationOrigin(expression.left, context),
      expressionEvaluationOrigin(expression.right, context)
    ]);
  }
  if (expression.kind === "ConditionalExpr") {
    return mergeEvaluationOrigins([
      expressionEvaluationOrigin(expression.condition, context),
      expressionEvaluationOrigin(expression.whenTrue, context),
      expressionEvaluationOrigin(expression.whenFalse, context)
    ]);
  }
  if (expression.kind === "CallExpr") {
    return mergeEvaluationOrigins([
      expressionEvaluationOrigin(expression.callee, context),
      ...expression.args.map(arg => expressionEvaluationOrigin(arg.value, context))
    ]);
  }
  if (expression.kind === "MatchExpr") {
    return mergeEvaluationOrigins([
      expressionEvaluationOrigin(expression.expression, context),
      ...expression.arms.flatMap(arm => [
        ...arm.patterns.map(pattern => expressionEvaluationOrigin(pattern, context)),
        expressionEvaluationOrigin(arm.value, context)
      ])
    ]);
  }
  return undefined;
}

/**
 * Tracks template-argument origins at the JSON paths produced by an expression.
 * Literal siblings deliberately receive no origin so they retain definition-file
 * extern scope even when another field is supplied by the caller.
 */
export function expressionEvaluationPathOrigins(
  expression: ExprNode,
  context: EvaluationContext,
  generatedPath: string
): EvaluationPathOrigin[] {
  if (expression.kind === "ListExpr") {
    // The legacy AST walker cannot know spread offsets without evaluating the
    // operand. Keep its conservative origin behavior; evaluateExpressionResult
    // owns exact same-evaluation spread and collection-builtin provenance.
    return expression.elements.flatMap((element, index) => {
      const value = element.kind === "ListSpread" ? element.expression : element;
      return expressionEvaluationPathOrigins(
        value,
        context,
        appendGeneratedPath(generatedPath, String(index))
      );
    });
  }
  if (expression.kind === "ObjectExpr" || expression.kind === "StateKeySugar") {
    const properties = expression.kind === "ObjectExpr" ? expression.properties : expression.entries;
    return properties.flatMap(property => {
      if (property.kind === "ObjectSpread") {
        const origin = expressionEvaluationOrigin(property.expression, context);
        return origin ? [{ generatedPath, ...origin }] : [];
      }
      const key = expression.kind === "ObjectExpr"
        ? propertyKeyToString(property, context)
        : stateKeyToString(property, context);
      return key === null
        ? []
        : expressionEvaluationPathOrigins(
          property.value,
          context,
          appendGeneratedPath(generatedPath, key)
        );
    });
  }
  if (expression.kind === "ModelApplySugar") {
    return [
      ...expressionEvaluationPathOrigins(
        expression.model,
        context,
        appendGeneratedPath(generatedPath, "model")
      ),
      ...expression.properties.flatMap(property =>
        expressionEvaluationPathOrigins(
          property.value,
          context,
          appendGeneratedPath(generatedPath, property.name.text)
        )
      )
    ];
  }
  if (expression.kind === "RandomApply") {
    return expression.entries.flatMap((entry, index) =>
      expressionEvaluationPathOrigins(entry, context, appendGeneratedPath(generatedPath, String(index)))
    );
  }
  if (expression.kind === "ConditionalExpr") {
    const selected = truthy(evaluateExpression(expression.condition, context))
      ? expression.whenTrue
      : expression.whenFalse;
    return expressionEvaluationPathOrigins(selected, context, generatedPath);
  }
  if (expression.kind === "MatchExpr") {
    const matchedValue = normalizeJsonValue(evaluateExpression(expression.expression, context));
    const selected = expression.arms.find(arm =>
      arm.patterns.some(pattern => matchesPattern(pattern, matchedValue, context))
    );
    return selected
      ? expressionEvaluationPathOrigins(selected.value, context, generatedPath)
      : [];
  }

  const origin = expressionEvaluationOrigin(expression, context);
  return origin ? [{ generatedPath, ...origin }] : [];
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

/** Evaluates an expression once and returns its selected-path provenance. */
export function evaluateExpressionResult(
  expression: ExprNode,
  context: EvaluationContext
): EvaluationResult {
  const session = new EvaluationTraceSession();
  const tracedContext = { ...context, evaluationTrace: session };
  const value = evaluateExpression(expression, tracedContext);
  return session.result() ?? directEvaluationResult(expression, value);
}

export function evaluateExpression(expression: ExprNode, context: EvaluationContext): EvaluationValue {
  evaluationItemBudget(context);
  const frame = context.evaluationTrace?.enter(expression, context);
  try {
    const value = contextualizeExpressionValue(
      expression,
      evaluateExpressionCore(expression, context),
      context
    );
    if (frame) {
      context.evaluationTrace!.leave(frame, value);
    }
    return value;
  } catch (error) {
    if (frame) {
      context.evaluationTrace!.abort(frame);
    }
    throw error;
  }
}

function evaluateExpressionCore(expression: ExprNode, context: EvaluationContext): EvaluationValue {
  if (expression.kind === "StringLiteral") {
    return expression.value;
  }
  if (expression.kind === "NumberLiteral") {
    return expression.value;
  }
  if (expression.kind === "BooleanLiteral") {
    return expression.value;
  }
  if (expression.kind === "NullLiteral") {
    return null;
  }
  if (expression.kind === "ResourceLocationExpr") {
    return evaluateResourceLocationExpression(expression, context);
  }
  if (expression.kind === "IdentifierExpr") {
    if (context.variables.has(expression.name.text)) {
      return context.variables.get(expression.name.text);
    }
    return builtinValues.get(expression.name.text) ?? expression.name.text;
  }
  if (expression.kind === "TemplateStringExpr") {
    return expression.parts.map(part => {
      if (part.kind === "text") {
        return part.text;
      }
      return evaluationScalarText(evaluateExpression(part.expression, context)) ?? "";
    }).join("");
  }
  if (expression.kind === "ListExpr") {
    return evaluateListExpression(expression.elements, context);
  }
  if (expression.kind === "ObjectExpr") {
    return evaluateObjectEntries(expression.properties, context);
  }
  if (expression.kind === "StateKeySugar") {
    return evaluateStateKeyProperties(expression.entries, context);
  }
  if (expression.kind === "ModelApplySugar") {
    const model = normalizeModelApplyValue(evaluateExpression(expression.model, context), context.namespace);
    const result = createJsonObject();
    setJsonObjectProperty(result, "model", model);
    for (const property of expression.properties) {
      setJsonObjectProperty(
        result,
        property.name.text,
        normalizeJsonValue(evaluateExpression(property.value, context))
      );
    }
    return omitBlockstateModelDefaults(result);
  }
  if (expression.kind === "RandomApply") {
    return expression.entries.map(entry => normalizeJsonValue(evaluateExpression(entry, context)));
  }
  if (expression.kind === "RangeExpr") {
    const start = Number(evaluateExpression(expression.startExpr, context));
    const end = Number(evaluateExpression(expression.endExpr, context));
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return [];
    }
    const distance = Math.abs(end - start);
    const itemCount = Math.floor(distance) + 1;
    if (!consumeEvaluationItems(
      context,
      Number.isSafeInteger(itemCount) ? itemCount : Number.POSITIVE_INFINITY,
      expression.range,
      "range"
    )) {
      return undefined;
    }
    const step = start <= end ? 1 : -1;
    const values = new Array<number>(itemCount);
    for (let index = 0; index < itemCount; index += 1) {
      // Index-based construction always terminates even beyond Number's exact
      // integer range, where repeatedly adding one can stop making progress.
      values[index] = start + index * step;
    }
    return values;
  }
  if (expression.kind === "ForInExpr") {
    return evaluateExpression(expression.iterable, context);
  }
  if (expression.kind === "CallExpr") {
    if (expression.callee.kind === "IdentifierExpr" && expression.callee.name.text === "seq") {
      return evaluateSeqExpression(expression, context);
    }
    const args = expression.args.map(arg => ({
      name: arg.name?.text,
      value: evaluateExpression(arg.value, context),
      range: arg.value.range,
      result: context.evaluationTrace?.latestChildResult(arg.value),
      sourceFile: context.sourceFile
    }));
    const calleeValue = evaluateExpression(expression.callee, context);
    if (isLambdaValue(calleeValue)) {
      return evaluateLambdaCall(calleeValue, expression.args.length, args, context);
    }
    if (
      expression.callee.kind === "IdentifierExpr"
      && hasEvaluationValueBinding(context, expression.callee.name.text)
    ) {
      context.onEvaluationFailure?.();
      return undefined;
    }
    return evaluateCallExpression(expression.callee, args, context, expression.range);
  }
  if (expression.kind === "LambdaExpr") {
    const parameterNames = new Set(expression.parameters.map(parameter => parameter.text));
    return {
      kind: "lambda",
      parameters: expression.parameters.map(parameter => parameter.text),
      body: expression.body,
      context: captureEvaluationContext(context),
      impureCalls: findLambdaImpureCalls(
        expression.body,
        name => parameterNames.has(name) || hasEvaluationValueBinding(context, name)
          ? undefined
          : builtinEffect(name)
      )
    };
  }
  if (expression.kind === "MemberExpr") {
    const objectValue = evaluateExpression(expression.object, context);
    if (isJsonObject(objectValue)) {
      return objectValue[expression.property.text] as EvaluationValue;
    }
    return undefined;
  }
  if (expression.kind === "IndexExpr") {
    const objectValue = evaluateExpression(expression.object, context);
    const indexValue = evaluateExpression(expression.index, context);
    if (Array.isArray(objectValue) && typeof indexValue === "number") {
      if (!isValidListIndex(indexValue, objectValue.length)) {
        reportRuntimeListIndexError(expression, indexValue, objectValue.length, context);
        return undefined;
      }
      return objectValue[indexValue] as EvaluationValue;
    }
    if (isJsonObject(objectValue)) {
      const key = scalarText(indexValue);
      return key === null ? undefined : objectValue[key] as EvaluationValue;
    }
    return undefined;
  }
  if (expression.kind === "ConditionalExpr") {
    return evaluateExpression(truthy(evaluateExpression(expression.condition, context)) ? expression.whenTrue : expression.whenFalse, context);
  }
  if (expression.kind === "MatchExpr") {
    return evaluateMatchExpression(expression.expression, expression.arms, context);
  }
  if (expression.kind === "BinaryExpr") {
    return evaluateBinaryExpression(expression.operator, evaluateExpression(expression.left, context), evaluateExpression(expression.right, context));
  }
  if (expression.kind === "UnaryExpr") {
    const value = evaluateExpression(expression.operand, context);
    return expression.operator === "!" ? !truthy(value) : -Number(value);
  }
  return undefined;
}

function contextualizeExpressionValue(
  expression: ExprNode,
  value: EvaluationValue,
  context: EvaluationContext
): EvaluationValue {
  const expectedType = context.resolvedExpectedTypes?.get(expression);
  if (!expectedType || value === undefined) {
    return value;
  }
  if (isLambdaValue(value) && expectedType.kind === "Function") {
    return {
      ...value,
      signature: {
        parameters: expectedType.parameters ?? [],
        returnType: expectedType.returnType ?? { kind: "Unknown" }
      }
    };
  }
  const converted = contextualizeEvaluatedValue(value, expectedType, context.namespace);
  if (!converted.ok) {
    reportContextualValueError(converted.error, expression.range, context);
    return undefined;
  }
  return converted.value as EvaluationValue;
}

function evaluateResourceLocationExpression(
  expression: Extract<ExprNode, { kind: "ResourceLocationExpr" }>,
  context: EvaluationContext
): EvaluationValue {
  const expectedType = context.resolvedExpectedTypes?.get(expression);
  const contextualKinds = expectedType ? contextualResourceKinds(expectedType) : [];
  if (contextualKinds.length === 0) {
    // Compatibility boundary: legacy resource-reference consumers still own
    // contextual canonicalization when semantic analysis did not publish an
    // explicit typed fact. Do not turn those values into generic brands that
    // a concrete model/texture sink must correctly reject.
    return expression.value.includes(":")
      ? expression.value
      : `${context.namespace}:${expression.value}`;
  }
  if (contextualKinds.length > 1) {
    // Preserve the raw spelling for the outer contextual converter so it can
    // report the ambiguity instead of first creating an arbitrary generic ID.
    return expression.value;
  }
  const resourceKind = contextualKinds[0] ?? "generic";
  const value = createEvaluatedResourceId(expression.value, resourceKind, context.namespace);
  if (value) {
    return value;
  }
  reportContextualValueError(
    {
      code: "rsgl.invalidConstructedResourceId",
      message: `Invalid ${typeKindForResourceValueKind(resourceKind)} '${expression.value}'.`
    },
    expression.range,
    context
  );
  return undefined;
}

function reportContextualValueError(
  error: { code: string; message: string },
  range: TextRange,
  context: EvaluationContext,
  sourceFile = context.sourceFile
): void {
  context.onEvaluationFailure?.();
  context.onResourceValueFailure?.();
  context.onError?.(error.code, error.message, range, sourceFile);
}

function evaluateSeqExpression(
  expression: Extract<ExprNode, { kind: "CallExpr" }>,
  context: EvaluationContext
): EvaluationValue {
  const patternArg = expression.args.find(arg => arg.name?.text === "pattern")
    ?? expression.args.filter(arg => !arg.name)[0];
  if (!patternArg) {
    return [];
  }

  const padArg = expression.args.find(arg => arg.name?.text === "pad");
  const padWidth = padArg ? sequencePadWidth(evaluateExpression(padArg.value, context)) : null;
  const generatorArgs = expression.args.filter(arg => arg !== patternArg && arg !== padArg);
  const positionalGeneratorArgs = generatorArgs.filter(arg => !arg.name);
  const positionalGenerators = positionalGeneratorArgs
    .map(arg => arg.value)
    .filter((value): value is Extract<ExprNode, { kind: "ForInExpr" }> => value.kind === "ForInExpr")
    .map(value => ({ name: value.binding.text, iterable: value.iterable }));
  const namedGenerators = generatorArgs
    .filter(arg => arg.name)
    .map(arg => ({ name: arg.name!.text, iterable: arg.value }));
  const generators = [...positionalGenerators, ...namedGenerators];
  if (generators.length === 0) {
    const patternValue = evaluateExpression(patternArg.value, context);
    if (isLambdaValue(patternValue)) {
      const value = evaluateLambdaCall(patternValue, 0, [], context);
      return expandSequencePatternWithinBudget(
        scalarText(value) ?? "",
        padWidth,
        context,
        expression.range
      );
    }
    return expandSequencePatternWithinBudget(
      scalarText(patternValue) ?? "",
      padWidth,
      context,
      expression.range
    );
  }
  if (positionalGenerators.length !== positionalGeneratorArgs.length) {
    return [];
  }

  const lambdaPattern = evaluateSeqLambdaPattern(patternArg.value, context);
  if (!lambdaPattern) {
    return [];
  }

  return evaluateSeqGeneratorPatterns(lambdaPattern, patternArg.value.range, generators, context, 0, [], padWidth);
}

function evaluateSeqGeneratorPatterns(
  lambdaPattern: LambdaValue,
  patternRange: TextRange,
  generators: SeqGenerator[],
  context: EvaluationContext,
  index: number,
  boundValues: EvaluationValue[],
  padWidth: number | null
): string[] | undefined {
  if (index >= generators.length) {
    const args = boundValues.map(value => ({ value, range: patternRange }));
    const value = evaluateLambdaCall(lambdaPattern, boundValues.length, args, context);
    return expandSequencePatternWithinBudget(
      scalarText(value) ?? "",
      padWidth,
      context,
      patternRange
    );
  }

  const generator = generators[index];
  const iterable = evaluateExpression(generator.iterable, context);
  if (!Array.isArray(iterable)) {
    return [];
  }

  const results: string[] = [];
  for (const value of iterable) {
    const name = generator.name;
    const bindingValue = sequenceBindingValue(value, padWidth);
    const child = childEvaluationContext(context, { [name]: bindingValue });
    const expanded = evaluateSeqGeneratorPatterns(
      lambdaPattern,
      patternRange,
      generators,
      child,
      index + 1,
      [...boundValues, bindingValue],
      padWidth
    );
    if (!expanded) {
      return undefined;
    }
    for (const item of expanded) {
      results.push(item);
    }
  }
  return results;
}

function expandSequencePatternWithinBudget(
  pattern: string,
  pad: number | null,
  context: EvaluationContext,
  range: TextRange
): string[] | undefined {
  const itemCount = sequencePatternExpansionCount(pattern);
  if (!consumeEvaluationItems(context, itemCount, range, "seq")) {
    return undefined;
  }
  return expandSequencePattern(pattern, { pad });
}

function evaluateSeqLambdaPattern(pattern: ExprNode, context: EvaluationContext): LambdaValue | null {
  if (pattern.kind !== "LambdaExpr" && pattern.kind !== "IdentifierExpr") {
    return null;
  }
  const value = evaluateExpression(pattern, context);
  return isLambdaValue(value) ? value : null;
}

function sequenceBindingValue(value: JsonValue, padWidth: number | null): JsonValue {
  return padWidth !== null && typeof value === "number" && Number.isFinite(value)
    ? formatSequenceNumber(value, padWidth)
    : normalizeJsonValue(value);
}

export function childEvaluationContext(
  context: EvaluationContext,
  values: Record<string, EvaluationValue>,
  metadata: Partial<Pick<EvaluationContext, "sourceFile" | "mappingReason" | "expansionStack" | "onError">> = {}
): EvaluationContext {
  const bindingNames = Object.keys(values);
  return {
    ...context,
    variables: new Map([...context.variables, ...Object.entries(values)]),
    valueBindingNames: bindingNames.length > 0
      ? new Set([...(context.valueBindingNames ?? []), ...bindingNames])
      : context.valueBindingNames,
    sourceFile: metadata.sourceFile ?? context.sourceFile,
    mappingReason: metadata.mappingReason ?? context.mappingReason,
    expansionStack: metadata.expansionStack ?? context.expansionStack,
    onError: metadata.onError ?? context.onError
  };
}

function evaluateListExpression(
  elements: readonly ListElementNode[],
  context: EvaluationContext
): EvaluationValue {
  const result: JsonValue[] = [];
  const paths: CollectionEvaluationTrace["paths"] = [];
  let requiresOwnershipTrace = false;
  for (const element of elements) {
    if (element.kind !== "ListSpread") {
      const value = evaluateExpression(element, context);
      const child = context.evaluationTrace?.latestChildResult(element);
      const outputPath = appendGeneratedPath("", String(result.length));
      result.push(normalizeJsonValue(value));
      if (child) {
        paths.push({
          outputPath,
          source: { result: child, sourceFile: context.sourceFile }
        });
      }
      continue;
    }

    requiresOwnershipTrace = true;
    const spreadValue = evaluateExpression(element.expression, context);
    const child = context.evaluationTrace?.latestChildResult(element.expression);
    if (spreadValue === undefined) {
      return undefined;
    }
    if (!Array.isArray(spreadValue)) {
      reportInvalidSpread(
        context,
        "rsgl.invalidListSpread",
        `List spread requires a List value, got ${runtimeEvaluationValueKind(spreadValue)}.`,
        element.range
      );
      return undefined;
    }
    if (!consumeEvaluationItems(context, spreadValue.length, element.range, "list spread")) {
      return undefined;
    }
    const offset = result.length;
    for (let index = 0; index < spreadValue.length; index += 1) {
      result.push(normalizeJsonValue(spreadValue[index]));
      if (child) {
        paths.push({
          outputPath: appendGeneratedPath("", String(offset + index)),
          source: {
            result: child,
            selectedPath: appendGeneratedPath("", String(index)),
            sourceFile: context.sourceFile
          }
        });
      }
    }
  }
  if (requiresOwnershipTrace) {
    context.evaluationTrace?.recordCollectionTrace({ paths });
  }
  return result;
}

function evaluateObjectEntries(
  entries: readonly ObjectEntryNode[],
  context: EvaluationContext
): EvaluationValue {
  const result = createJsonObject();
  const pathOwners = new Map<string, CollectionEvaluationTrace["paths"][number]["source"]>();
  let requiresOwnershipTrace = false;
  for (const entry of entries) {
    if (entry.kind === "ObjectSpread") {
      requiresOwnershipTrace = true;
      const spreadValue = evaluateExpression(entry.expression, context);
      const child = context.evaluationTrace?.latestChildResult(entry.expression);
      if (spreadValue === undefined) {
        return undefined;
      }
      if (!isJsonObject(spreadValue)) {
        reportInvalidSpread(
          context,
          "rsgl.invalidObjectSpread",
          `Object spread requires an Object value, got ${runtimeEvaluationValueKind(spreadValue)}.`,
          entry.range
        );
        return undefined;
      }
      const keys = jsonObjectKeys(spreadValue);
      if (!consumeEvaluationItems(context, keys.length, entry.range, "object spread")) {
        return undefined;
      }
      for (const key of keys) {
        setJsonObjectProperty(result, key, normalizeJsonValue(spreadValue[key]));
        if (child) {
          pathOwners.set(key, {
            result: child,
            selectedPath: appendGeneratedPath("", key),
            sourceFile: context.sourceFile
          });
        } else {
          pathOwners.delete(key);
        }
      }
      continue;
    }

    const key = propertyKeyToString(entry, context);
    const value = evaluateExpression(entry.value, context);
    const child = context.evaluationTrace?.latestChildResult(entry.value);
    if (key !== null) {
      requiresOwnershipTrace ||= pathOwners.has(key);
      setJsonObjectProperty(result, key, normalizeJsonValue(value));
      if (child) {
        pathOwners.set(key, { result: child, sourceFile: context.sourceFile });
      } else {
        pathOwners.delete(key);
      }
    }
  }
  if (requiresOwnershipTrace) {
    context.evaluationTrace?.recordCollectionTrace({
      paths: Array.from(pathOwners, ([key, source]) => ({
        outputPath: appendGeneratedPath("", key),
        source
      }))
    });
  }
  return result;
}

function consumeEvaluationItems(
  context: EvaluationContext,
  count: number,
  range: TextRange,
  operation: string
): boolean {
  const budget = evaluationItemBudget(context);
  if (budget.tryConsume(count)) {
    return true;
  }
  context.onEvaluationFailure?.();
  context.onError?.(
    "rsgl.collectionExpansionLimit",
    `Collection operation '${operation}' exceeds maxEvaluationItems=${budget.limit} `
      + `(consumed ${budget.consumed}, requested ${Number.isSafeInteger(count) ? count : `more than ${budget.remaining}`}).`,
    range,
    context.sourceFile
  );
  return false;
}

function reportInvalidSpread(
  context: EvaluationContext,
  code: "rsgl.invalidListSpread" | "rsgl.invalidObjectSpread",
  message: string,
  range: TextRange
): void {
  context.onEvaluationFailure?.();
  context.onError?.(code, message, range, context.sourceFile);
}

function evaluationItemBudget(context: EvaluationContext): EvaluationItemBudget {
  context.evaluationItemBudget ??= new EvaluationItemBudget();
  return context.evaluationItemBudget;
}

function runtimeEvaluationValueKind(value: EvaluationValue): string {
  if (value === undefined) {
    return "Undefined";
  }
  if (value === null) {
    return "Null";
  }
  if (Array.isArray(value)) {
    return "List";
  }
  switch (typeof value) {
    case "boolean":
      return "Boolean";
    case "number":
      return "Number";
    case "string":
      return "String";
    default:
      return "Object";
  }
}

function isObjectPropertyNode(entry: ObjectEntryNode): entry is ObjectPropertyNode {
  return entry.kind === "ObjectProperty";
}

function evaluateStateKeyProperties(properties: ObjectPropertyNode[], context: EvaluationContext): Record<string, JsonValue> {
  const result = createJsonObject();
  for (const property of properties) {
    const key = stateKeyToString(property, context);
    if (key !== null) {
      setJsonObjectProperty(
        result,
        key,
        normalizeJsonValue(evaluateExpression(property.value, context))
      );
    }
  }
  return result;
}

function propertyKeyToString(property: ObjectPropertyNode, context: EvaluationContext): string | null {
  if (property.key.kind === "Identifier") {
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  if (property.key.kind === "NumberLiteral") {
    return property.key.raw;
  }
  const value = evaluateExpression(property.key.expression, context);
  return scalarText(value);
}

function stateKeyToString(property: ObjectPropertyNode, context: EvaluationContext): string | null {
  if (property.key.kind === "Identifier") {
    if (context.stateKeyAliases?.has(property.key.text)) {
      const value = context.variables.get(property.key.text);
      return scalarText(value) ?? property.key.text;
    }
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  if (property.key.kind === "NumberLiteral") {
    return property.key.raw;
  }
  const value = evaluateExpression(property.key.expression, context);
  return scalarText(value);
}

function normalizeModelApplyValue(value: EvaluationValue, namespace: string): JsonValue {
  const text = scalarText(value);
  if (text === null) {
    return normalizeJsonValue(value);
  }
  return text.includes(":") ? text : `${namespace}:${text}`;
}

function scalarText(value: EvaluationValue): string | null {
  return evaluationScalarText(value);
}

function evaluateBinaryExpression(operator: string, left: EvaluationValue, right: EvaluationValue): EvaluationValue {
  if (operator === "+") {
    if (typeof left === "string" || typeof right === "string" || isEvaluatedResourceValue(left) || isEvaluatedResourceValue(right)) {
      return `${scalarText(left) ?? ""}${scalarText(right) ?? ""}`;
    }
    return Number(left) + Number(right);
  }
  if (operator === "-") {
    return Number(left) - Number(right);
  }
  if (operator === "*") {
    return Number(left) * Number(right);
  }
  if (operator === "/") {
    return Number(left) / Number(right);
  }
  if (operator === "%") {
    return Number(left) % Number(right);
  }
  if (operator === "==") {
    return left === right;
  }
  if (operator === "!=") {
    return left !== right;
  }
  if (operator === "<") {
    return compareValues(left, right) < 0;
  }
  if (operator === "<=") {
    return compareValues(left, right) <= 0;
  }
  if (operator === ">") {
    return compareValues(left, right) > 0;
  }
  if (operator === ">=") {
    return compareValues(left, right) >= 0;
  }
  if (operator === "&&") {
    return truthy(left) && truthy(right);
  }
  if (operator === "||") {
    return truthy(left) || truthy(right);
  }
  return undefined;
}

interface EvaluationCallArgument {
  name?: string;
  value: EvaluationValue;
  range: TextRange;
  result?: EvaluationResult;
  sourceFile?: string;
}

function evaluateCallExpression(
  callee: ExprNode,
  args: EvaluationCallArgument[],
  context: EvaluationContext,
  range: TextRange
): EvaluationValue {
  if (callee.kind !== "IdentifierExpr") {
    context.onEvaluationFailure?.();
    return undefined;
  }

  const signature = getBuiltinSignature(callee.name.text);
  if (signature) {
    const binding = bindRsglArgumentSlots(
      signature.parameters,
      args,
      arg => arg.name
    );
    if (binding.issues.length > 0) {
      // Semantic checking emits the actionable binder diagnostic. Runtime uses
      // the same slot result as a strict gate so malformed calls never execute.
      context.onEvaluationFailure?.();
      return undefined;
    }
    args = binding.assignments.map(assignment => assignment.arg);
  }

  if (isRsglResourceIdConstructorName(callee.name.text)) {
    return evaluateResourceIdConstructor(callee.name.text, args, context);
  }

  const collection = evaluateCollectionBuiltin(
    callee.name.text,
    args,
    range,
    collectionBuiltinHost(context)
  );
  if (collection.handled) {
    if (collection.trace) {
      context.evaluationTrace?.recordCollectionTrace(collection.trace);
    }
    return collection.value;
  }

  if (callee.name.text === "glob") {
    const pattern = argumentValue(args, "pattern", 0);
    const budget = evaluationItemBudget(context);
    const globLimit = Math.min(budget.remaining, MAX_EVALUATION_ITEMS_PER_ALLOCATION);
    const loaded = typeof pattern === "string"
      ? context.globLoader?.(pattern, context, range, {
        maxMatches: globLimit,
        maxVisitedEntries: globLimit
      })
      : undefined;
    if (loaded && !Array.isArray(loaded)) {
      consumeEvaluationItems(context, globLimit + 1, range, "glob");
      return undefined;
    }
    const matches = loaded ?? [];
    return consumeEvaluationItems(context, matches.length, range, "glob")
      ? matches
      : undefined;
  }
  if (callee.name.text === "pad") {
    const value = scalarText(argumentValue(args, "value", 0)) ?? "";
    const width = Number(argumentValue(args, "width", 1) ?? 0);
    return value.padStart(width, "0");
  }
  if (callee.name.text === "seq") {
    const pattern = scalarText(argumentValue(args, "pattern", 0)) ?? "";
    return expandSequencePatternWithinBudget(pattern, null, context, range);
  }
  if (callee.name.text === "yaw") {
    return horizontalYaw[scalarText(argumentValue(args, "direction", 0)) ?? ""] ?? 0;
  }
  if (callee.name.text === "model_path") {
    return resourceAssetPath(argumentValue(args, "id", 0), context.namespace, "models", "json");
  }
  if (callee.name.text === "texture_path") {
    return resourceAssetPath(argumentValue(args, "id", 0), context.namespace, "textures", "png");
  }
  if (callee.name.text === "resource_namespace") {
    return parseResourceIdValue(argumentValue(args, "id", 0), context.namespace)?.namespace ?? "";
  }
  if (callee.name.text === "resource_path") {
    return parseResourceIdValue(argumentValue(args, "id", 0), context.namespace)?.path ?? "";
  }
  if (callee.name.text === "startsWith") {
    return (scalarText(argumentValue(args, "str", 0)) ?? "")
      .startsWith(scalarText(argumentValue(args, "prefix", 1)) ?? "");
  }
  if (callee.name.text === "endsWith") {
    return (scalarText(argumentValue(args, "str", 0)) ?? "")
      .endsWith(scalarText(argumentValue(args, "suffix", 1)) ?? "");
  }
  if (callee.name.text === "has") {
    const object = argumentValue(args, "object", 0);
    const key = argumentValue(args, "key", 1);
    return typeof key === "string" && hasOwnEvaluationProperty(object, key);
  }
  if (callee.name.text === "replace") {
    const source = scalarText(argumentValue(args, "str", 0)) ?? "";
    const oldText = scalarText(argumentValue(args, "old", 1)) ?? "";
    const newText = scalarText(argumentValue(args, "new", 2)) ?? "";
    return oldText ? source.split(oldText).join(newText) : source;
  }
  if (callee.name.text === "padStart") {
    const source = scalarText(argumentValue(args, "str", 0)) ?? "";
    const length = Number(argumentValue(args, "len", 1) ?? 0);
    const pad = scalarText(argumentValue(args, "pad", 2)) ?? "";
    return source.padStart(length, pad);
  }
  if (callee.name.text === "padEnd") {
    const source = scalarText(argumentValue(args, "str", 0)) ?? "";
    const length = Number(argumentValue(args, "len", 1) ?? 0);
    const pad = scalarText(argumentValue(args, "pad", 2)) ?? "";
    return source.padEnd(length, pad);
  }

  context.onEvaluationFailure?.();
  return undefined;
}

function collectionBuiltinHost(context: EvaluationContext) {
  return {
    budget: evaluationItemBudget(context),
    isLambda: isLambdaValue,
    invokeLambda: (lambda: LambdaValue, argument: CollectionLambdaArgument) => {
      const result = argument.result && argument.selectedPath !== undefined
        ? selectEvaluationResultPath(argument.result, argument.selectedPath)
        : argument.result;
      const argumentRange = result
        ? rangeForEvaluationPath(result.pathRanges, "") ?? argument.range
        : argument.range;
      const value = evaluateLambdaCall(lambda, 1, [{
        value: argument.value,
        range: argumentRange,
        ...(result ? { result } : {}),
        sourceFile: argument.sourceFile
      }], context);
      return {
        value,
        result: context.evaluationTrace?.latestChildResult(lambda.body),
        sourceFile: lambda.context.sourceFile
      };
    },
    reportError: (code: string, message: string, range: TextRange) => {
      context.onError?.(code, message, range, context.sourceFile);
    },
    markFailure: () => context.onEvaluationFailure?.()
  };
}

function evaluateResourceIdConstructor(
  constructorName: keyof typeof rsglResourceIdConstructors,
  args: EvaluationCallArgument[],
  context: EvaluationContext
): EvaluationValue {
  if (args.length !== 1) {
    // Semantic argument binding owns the arity/name diagnostic. Runtime still
    // gates the call so a malformed constructor cannot materialize a value.
    context.onEvaluationFailure?.();
    return undefined;
  }
  const argument = args[0];
  if (argument.value === undefined) {
    // The argument evaluation already owns the actionable diagnostic. Do not
    // reinterpret its failure as a second resource-reference shape error at
    // the enclosing constructor boundary.
    context.onEvaluationFailure?.();
    return undefined;
  }
  const expectedKind = rsglResourceIdConstructors[constructorName];
  const argumentText = evaluationScalarText(argument.value);
  if (constructorName === "texture_id" && argumentText?.startsWith("#")) {
    reportContextualValueError(
      {
        code: "rsgl.invalidConstructedResourceId",
        message: `texture_id cannot construct a TextureId from texture variable '${argumentText}'.`
      },
      argument.range,
      context
    );
    return undefined;
  }
  const converted = contextualizeEvaluatedValue(
    argument.value,
    { kind: typeKindForResourceValueKind(expectedKind) },
    context.namespace
  );
  if (!converted.ok) {
    reportContextualValueError(converted.error, argument.range, context);
    return undefined;
  }
  return converted.value as EvaluationValue;
}

function isValidListIndex(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

function reportRuntimeListIndexError(
  expression: Extract<ExprNode, { kind: "IndexExpr" }>,
  index: number,
  length: number,
  context: EvaluationContext
): void {
  context.onEvaluationFailure?.();
  // A literal index into a literal list has an exact static length. The
  // semantic checker owns that diagnostic so compilation never reports the
  // same out-of-bounds access twice.
  if (
    expression.object.kind === "ListExpr"
    && expression.index.kind === "NumberLiteral"
    && expression.object.elements.every(element => element.kind !== "ListSpread")
  ) {
    return;
  }
  const message = !Number.isInteger(index) || index < 0
    ? `List index ${index} must be a non-negative integer.`
    : length === 0
      ? `List index ${index} is outside an empty runtime list.`
      : `List index ${index} is outside the runtime list bounds 0..${length - 1}.`;
  context.onError?.(
    "rsgl.indexOutOfBounds",
    message,
    expression.index.range,
    context.sourceFile
  );
}

function evaluateLambdaCall(
  lambda: LambdaValue,
  argCount: number,
  args: EvaluationCallArgument[],
  callContext: EvaluationContext
): EvaluationValue {
  if (lambda.impureCalls.length > 0) {
    // Enforcement only: the semantic layer reports rsgl.lambdaImpureCall at the
    // lambda's definition site, so the gate refuses execution without adding a
    // duplicate diagnostic.
    callContext.onEvaluationFailure?.();
    return undefined;
  }
  if (argCount !== lambda.parameters.length) {
    // Semantic checking owns the single diagnostic, including calls through
    // imported/re-exported signatures. Runtime remains a strict gate so an
    // invalid call cannot materialize output with partially bound values.
    callContext.onEvaluationFailure?.();
    return undefined;
  }
  const onError = callContext.onError ?? lambda.context.onError;

  const positional = args.filter(arg => !arg.name);
  const values: Record<string, EvaluationValue> = {};
  const bindings = new Map<string, EvaluationCallArgument | undefined>();
  lambda.parameters.forEach((parameter, index) => {
    const arg = args.find(item => item.name === parameter) ?? positional[index];
    const expectedType = lambda.signature?.parameters[index];
    if (!arg || !expectedType || arg.value === undefined) {
      values[parameter] = arg?.value;
    } else {
      const converted = contextualizeEvaluatedValue(
        arg.value,
        expectedType,
        callContext.namespace
      );
      if (!converted.ok) {
        reportContextualValueError(converted.error, arg.range, callContext);
        values[parameter] = undefined;
      } else {
        values[parameter] = converted.value as EvaluationValue;
      }
    }
    bindings.set(parameter, arg);
  });
  if (lambda.parameters.some(parameter => values[parameter] === undefined)) {
    return undefined;
  }

  const bodyContext = childEvaluationContext(lambda.context, values, { onError });
  bodyContext.evaluationItemBudget = callContext.evaluationItemBudget
    ?? lambda.context.evaluationItemBudget;
  bodyContext.evaluationTrace = callContext.evaluationTrace;
  bodyContext.onEvaluationFailure = callContext.onEvaluationFailure
    ?? lambda.context.onEvaluationFailure;
  bodyContext.onResourceValueFailure = callContext.onResourceValueFailure
    ?? lambda.context.onResourceValueFailure;
  for (const [parameter, arg] of bindings) {
    if (arg?.result) {
      bindEvaluationResult(
        bodyContext,
        parameter,
        { ...arg.result, value: values[parameter] },
        callContext.sourceFile
      );
    }
  }
  // Defense in depth: even if the purity scan misses a pattern, the body
  // cannot reach filesystem loaders.
  bodyContext.baseDocumentLoader = undefined;
  bodyContext.onDependency = undefined;
  bodyContext.globLoader = undefined;
  const value = evaluateExpression(lambda.body, bodyContext);
  const returnType = lambda.signature?.returnType;
  if (!returnType || value === undefined) {
    return value;
  }
  const converted = contextualizeEvaluatedValue(
    value,
    returnType,
    lambda.context.namespace
  );
  if (!converted.ok) {
    reportContextualValueError(
      converted.error,
      lambda.body.range,
      bodyContext,
      lambda.context.sourceFile
    );
    return undefined;
  }
  return converted.value as EvaluationValue;
}

function isLambdaValue(value: EvaluationValue): value is LambdaValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<LambdaValue>;
  return candidate.kind === "lambda"
    && Array.isArray(candidate.parameters)
    && Boolean(candidate.body && typeof candidate.body === "object")
    && Boolean(candidate.context && typeof candidate.context === "object")
    && Array.isArray(candidate.impureCalls);
}

function captureEvaluationContext(context: EvaluationContext): EvaluationContext {
  const captured = { ...context };
  delete captured.evaluationTrace;
  return {
    ...captured,
    variables: new Map(context.variables),
    stateKeyAliases: context.stateKeyAliases ? new Set(context.stateKeyAliases) : undefined,
    valueOrigins: context.valueOrigins ? new Map(context.valueOrigins) : undefined,
    valuePathOrigins: context.valuePathOrigins ? new Map(context.valuePathOrigins) : undefined,
    valueIssues: context.valueIssues ? new Map(context.valueIssues) : undefined
  };
}

function argumentValue(args: Array<{ name?: string; value: EvaluationValue }>, name: string, positionalIndex: number): EvaluationValue {
  return args.find(arg => arg.name === name)?.value
    ?? args.filter(arg => !arg.name)[positionalIndex]?.value;
}

function evaluateMatchExpression(
  expression: ExprNode,
  arms: Array<{ patterns: ExprNode[]; value: ExprNode }>,
  context: EvaluationContext
): EvaluationValue {
  const matchedValue = normalizeJsonValue(evaluateExpression(expression, context));
  for (const arm of arms) {
    if (arm.patterns.some(pattern => matchesPattern(pattern, matchedValue, context))) {
      return evaluateExpression(arm.value, context);
    }
  }
  return undefined;
}

function matchesPattern(pattern: ExprNode, value: JsonValue, context: EvaluationContext): boolean {
  if (pattern.kind === "IdentifierExpr" && pattern.name.text === "_") {
    return true;
  }
  return jsonEquals(normalizeJsonValue(evaluateExpression(pattern, context)), value);
}

function compareValues(left: EvaluationValue, right: EvaluationValue): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return (scalarText(left) ?? "").localeCompare(scalarText(right) ?? "");
}

function resourceAssetPath(
  value: EvaluationValue,
  namespace: string,
  root: string,
  extension: string
): string {
  const id = parseResourceIdValue(value, namespace);
  if (!id) {
    return "";
  }
  return `assets/${id.namespace}/${root}/${id.path}.${extension}`;
}

function parseResourceIdValue(
  value: EvaluationValue,
  namespace: string
): { namespace: string; path: string } | null {
  if (isEvaluatedResourceId(value)) {
    return { namespace: value.namespace, path: value.path };
  }
  const text = scalarText(value);
  return text && !text.startsWith("#") ? tryParseMinecraftResourceId(text, namespace) : null;
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (isEvaluatedResourceId(left) || isEvaluatedResourceId(right)) {
    return isEvaluatedResourceId(left)
      && isEvaluatedResourceId(right)
      && left.resourceKind === right.resourceKind
      && left.namespace === right.namespace
      && left.path === right.path;
  }
  if (isEvaluatedResourceValue(left) || isEvaluatedResourceValue(right)) {
    return isEvaluatedResourceValue(left)
      && isEvaluatedResourceValue(right)
      && evaluationScalarText(left) === evaluationScalarText(right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => jsonEquals(item, right[index]));
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) {
      return false;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every(key => jsonEquals(left[key] as JsonValue, right[key] as JsonValue));
  }
  return false;
}

function truthy(value: EvaluationValue): boolean {
  return Boolean(value);
}

function omitBlockstateModelDefaults(model: Record<string, JsonValue>): Record<string, JsonValue> {
  const result = createJsonObject();
  for (const [key, value] of jsonObjectEntries(model)) {
    if ((key === "x" || key === "y" || key === "z") && value === 0) {
      continue;
    }
    if (key === "uvlock" && value === false) {
      continue;
    }
    if (key === "weight" && value === 1) {
      continue;
    }
    setJsonObjectProperty(result, key, value);
  }
  return result;
}

function hasOwnEvaluationProperty(value: EvaluationValue, key: string): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && !isEvaluatedResourceValue(value)
    && !isLambdaValue(value)
    && Object.hasOwn(value, key)
  );
}
