import {
  ExprNode,
  TextRange
} from "../parser";
import { resourceBodyMessages, statePredicateMessages } from "../diagnosticMessages";
import { builtinEffect } from "../semantic/builtins";
import { findLambdaImpureCalls } from "../semantic/lambdaPurity";
import { typeKindForResourceValueKind } from "../resourceIdSemantics";
import { normalizeJsonValue } from "./evaluationJsonValues";
import { isJsonObject } from "./jsonValues";
import {
  contextualResourceKinds,
  contextualizeEvaluatedValue
} from "./contextualResourceValueConversion";
import {
  createEvaluatedResourceId,
  createEvaluatedTextureVariable,
  evaluationScalarText,
  isEvaluatedResourceId,
  isEvaluatedResourceValue,
  isEvaluatedTextureVariable
} from "./evaluatedResourceValues";
import { JsonValue } from "./ir";
import { evaluationItemBudget } from "./evaluationBudget";
import { consumeEvaluationItems } from "./evaluationItemAccounting";
import {
  isModuleNamespaceValue
} from "./moduleNamespaceValue";
import {
  evaluateStatePredicateBinary,
  evaluateStatePredicateUnary,
  isStateNamespaceValue,
  isStatePredicateValue,
  preflightStatePredicateExpression,
  isStatePropertyValue,
  stateNamespaceValue,
  statePropertyValue
} from "./blockstatePredicate";
import { hasEvaluationValueBinding } from "./evaluationBindings";
import { reportContextualValueError } from "./evaluationErrors";
import {
  evaluateListExpression,
  evaluateObjectEntries
} from "./collectionExpressionEvaluation";
import {
  directEvaluationResult,
  EvaluationTraceSession
} from "./evaluationTrace";
import type {
  EvaluationContext,
  EvaluationResult,
  EvaluationValue
} from "./evaluationTypes";
import type { EvaluationRuntimeHost } from "./evaluationRuntimeHost";
import { evaluateCallExpression } from "./callEvaluation";
import {
  captureEvaluationContext,
  evaluateLambdaCall,
  isLambdaValue
} from "./lambdaEvaluation";
import {
  evaluateSeqExpression
} from "./sequenceEvaluation";

export type {
  EvaluationContext,
  EvaluationOrigin,
  EvaluationPathOrigin,
  EvaluationPathRange,
  EvaluationResult,
  EvaluationValue,
  EvaluationValueIssue,
  EvaluationValueIssueKind,
  LambdaValue,
  RawGlobLoader,
  RawGlobLoadLimits,
  RawGlobLoadResult,
  RawGlobLimitExceeded
} from "./evaluationTypes";

export {
  bindEvaluationResult,
  bindEvaluationValue,
  hasEvaluationValueBinding
} from "./evaluationBindings";
export {
  materializeEvaluationPathOrigins,
  materializeEvaluationSelectionPathOrigins,
  materializeEvaluationValueIssues,
  originForEvaluationPath,
  rangeForEvaluationPath,
  selectEvaluationPathOrigins,
  selectEvaluationValueIssues
} from "./evaluationProvenance";

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
  if (
    !context.evaluatingStatePredicate
    && context.resolvedExpectedTypes?.get(expression)?.kind === "StatePredicate"
  ) {
    if (!preflightStatePredicateExpression(expression, context)) {
      return undefined;
    }
    context = { ...context, evaluatingStatePredicate: true };
  }
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

const evaluationRuntimeHost: EvaluationRuntimeHost = {
  evaluateExpression,
  childEvaluationContext
};

/** Evaluates a compile-time branch without coercing runtime block-state values. */
export function evaluateCompileTimeCondition(
  expression: ExprNode,
  context: EvaluationContext
): boolean | undefined {
  const value = evaluateExpression(expression, context);
  if (isStateNamespaceValue(value) || isStatePropertyValue(value) || isStatePredicateValue(value)) {
    context.onEvaluationFailure?.();
    context.onError?.(
      "rsgl.statePredicateCompileTimeCondition",
      statePredicateMessages.compileTimeCondition,
      expression.range,
      context.sourceFile
    );
    return undefined;
  }
  return Boolean(value);
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
  if (expression.kind === "TextureVariableLiteral") {
    return createEvaluatedTextureVariable(`#${expression.name.text}`) ?? undefined;
  }
  if (expression.kind === "ResourceLocationExpr") {
    return evaluateResourceLocationExpression(expression, context);
  }
  if (expression.kind === "IdentifierExpr") {
    if (expression.name.text === "$state") {
      return stateNamespaceValue;
    }
    if (context.variables.has(expression.name.text)) {
      return context.variables.get(expression.name.text);
    }
    return builtinValues.get(expression.name.text) ?? expression.name.text;
  }
  if (expression.kind === "TemplateStringExpr") {
    let textureVariableInterpolation = false;
    const value = expression.parts.map(part => {
      if (part.kind === "text") {
        return part.text;
      }
      const evaluated = evaluateExpression(part.expression, context);
      textureVariableInterpolation ||= isEvaluatedTextureVariable(evaluated);
      return evaluationScalarText(evaluated) ?? "";
    }).join("");
    return preserveTextureVariableTextTaint(
      value,
      textureVariableInterpolation,
      expression.range,
      context
    );
  }
  if (expression.kind === "ListExpr") {
    return evaluateListExpression(expression.elements, context, evaluationRuntimeHost);
  }
  if (expression.kind === "ObjectExpr") {
    return evaluateObjectEntries(expression.properties, context, evaluationRuntimeHost);
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
      return evaluateSeqExpression(expression, context, evaluationRuntimeHost);
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
      return evaluateLambdaCall(
        calleeValue,
        expression.args.length,
        args,
        context,
        evaluationRuntimeHost
      );
    }
    if (
      expression.callee.kind === "IdentifierExpr"
      && hasEvaluationValueBinding(context, expression.callee.name.text)
    ) {
      context.onEvaluationFailure?.();
      return undefined;
    }
    return evaluateCallExpression(
      expression.callee,
      args,
      context,
      expression.range,
      evaluationRuntimeHost
    );
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
    if (isStateNamespaceValue(objectValue)) {
      return statePropertyValue(expression.property.text, context, expression.property.range);
    }
    if (isModuleNamespaceValue(objectValue)) {
      return objectValue.resolveValue(expression.property.text)?.value;
    }
    if (isJsonObject(objectValue)) {
      return objectValue[expression.property.text] as EvaluationValue;
    }
    return undefined;
  }
  if (expression.kind === "IndexExpr") {
    const objectValue = evaluateExpression(expression.object, context);
    const indexValue = evaluateExpression(expression.index, context);
    if (isStateNamespaceValue(objectValue)) {
      return statePropertyValue(indexValue, context, expression.index.range);
    }
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
    const condition = evaluateCompileTimeCondition(expression.condition, context);
    return condition === undefined
      ? undefined
      : evaluateExpression(condition ? expression.whenTrue : expression.whenFalse, context);
  }
  if (expression.kind === "MatchExpr") {
    return evaluateMatchExpression(expression.expression, expression.arms, context);
  }
  if (expression.kind === "BinaryExpr") {
    return evaluateBinaryExpression(
      expression.operator,
      evaluateExpression(expression.left, context),
      evaluateExpression(expression.right, context),
      context,
      expression.range
    );
  }
  if (expression.kind === "UnaryExpr") {
    const value = evaluateExpression(expression.operand, context);
    const statePredicate = evaluateStatePredicateUnary(
      expression.operator,
      value,
      context,
      expression.range
    );
    if (statePredicate.handled) {
      return statePredicate.value;
    }
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
  if (expectedType.kind === "StatePredicate" && isStatePredicateValue(value)) {
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
    // Untyped resource locations remain canonical strings until a concrete JSON
    // sink applies its own resource-reference semantics.
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

function scalarText(value: EvaluationValue): string | null {
  return evaluationScalarText(value);
}

function evaluateBinaryExpression(
  operator: string,
  left: EvaluationValue,
  right: EvaluationValue,
  context: EvaluationContext,
  range: TextRange
): EvaluationValue {
  const statePredicate = evaluateStatePredicateBinary(
    operator,
    left,
    right,
    context,
    range
  );
  if (statePredicate.handled) {
    return statePredicate.value;
  }
  if (operator === "+") {
    if (typeof left === "string" || typeof right === "string" || isEvaluatedResourceValue(left) || isEvaluatedResourceValue(right)) {
      return preserveTextureVariableTextTaint(
        `${scalarText(left) ?? ""}${scalarText(right) ?? ""}`,
        isEvaluatedTextureVariable(left) || isEvaluatedTextureVariable(right),
        range,
        context
      );
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
  if (operator === "in" || operator === "not in") {
    context.onEvaluationFailure?.();
    context.onError?.(
      "rsgl.statePredicateOperatorContext",
      `'${operator}' is only available in a StatePredicate expression.`,
      range,
      context.sourceFile
    );
  }
  return undefined;
}

function preserveTextureVariableTextTaint(
  value: string,
  tainted: boolean,
  range: TextRange,
  context: EvaluationContext
): EvaluationValue {
  if (!tainted) {
    return value;
  }
  const textureVariable = createEvaluatedTextureVariable(value);
  if (textureVariable) {
    return textureVariable;
  }
  reportContextualValueError({
    code: "rsgl.textureVariableInvalidContext",
    message: resourceBodyMessages.textureVariableOutsideModelSink
  }, range, context);
  return undefined;
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
  if (isStateNamespaceValue(value) || isStatePropertyValue(value) || isStatePredicateValue(value)) {
    return false;
  }
  return Boolean(value);
}
