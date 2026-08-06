import type { ExprNode, ObjectExprNode } from "../parser";
import { checkCallExpression, type RsglCallCheckHost } from "./callChecking";
import { isCollectionBuiltinName } from "./collectionBuiltinInference";
import { selectContextualObjectArm } from "./contextualObjectChecking";
import { diagnostic } from "./diagnostics";
import { checkMatchExhaustiveness, isWildcardPattern } from "./domainChecks";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { checkLambdaExpression } from "./lambdaTyping";
import { resolveListSpreadElementType } from "./listSpreadTypes";
import {
  validateContextualResourceLiteral,
  validateResourceLocationValue,
  validateTextureRefExpressionSyntax
} from "./resourceExpressionSyntax";
import { lookup } from "./scopes";
import { scopeForTruthyCondition } from "./typeNarrowing";
import { combineRsglTypes, inferListType, rsglTypeKey } from "./typeNormalization";
import { formatType, isAssignable } from "./typeRelations";
import { inferredUnionBudgetOptions } from "./unionBudget";
import {
  resourceIdType,
  mayContainTextureVariable,
  textureIdType,
  textureRefType,
  textureVariableType,
  unknownType,
  type RsglScope,
  type RsglType
} from "./types";

export interface ContextualExpressionCheckHost extends RsglCallCheckHost {
  checkBlockstatePredicate(
    context: RsglExpressionCheckContext,
    expression: ExprNode,
    scope: RsglScope
  ): RsglType;
  checkObjectExpression(
    context: RsglExpressionCheckContext,
    expression: ObjectExprNode,
    scope: RsglScope,
    expectedType: RsglType
  ): RsglType;
}

export function checkResourceIdExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  host: ContextualExpressionCheckHost
): RsglType {
  if (expression.kind === "TextureVariableLiteral") {
    recordResolvedExpectedType(context, expression, textureVariableType);
    return textureVariableType;
  }
  if (expression.kind === "StringLiteral") {
    validateContextualResourceLiteral(context, expression);
    return resourceIdType;
  }
  if (expression.kind === "TemplateStringExpr") {
    host.checkExpression(context, expression, scope);
    return resourceIdType;
  }
  if (expression.kind === "ResourceLocationExpr") {
    validateResourceLocationValue(context, expression.value, expression.range);
    return resourceIdType;
  }
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    return resourceIdType;
  }
  return host.checkExpression(context, expression, scope);
}

export function checkExpressionForExpectedType(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  expectedType: RsglType,
  host: ContextualExpressionCheckHost
): RsglType {
  const type = checkExpressionForExpectedTypeCore(
    context,
    expression,
    scope,
    expectedType,
    host
  );
  context.recordResolvedExpressionType?.(expression, type);
  return type;
}

function checkExpressionForExpectedTypeCore(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  expectedType: RsglType,
  host: ContextualExpressionCheckHost
): RsglType {
  if (expectedType.kind === "StatePredicate") {
    return host.checkBlockstatePredicate(context, expression, scope);
  }
  if (
    expression.kind === "CallExpr"
    && expression.callee.kind === "IdentifierExpr"
    && isCollectionBuiltinName(expression.callee.name.text)
    && lookup(scope, expression.callee.name.text)?.kind === "builtin"
  ) {
    recordResolvedExpectedType(context, expression, expectedType);
    return checkCallExpression(
      context,
      expression,
      scope,
      host,
      false,
      expectedType
    );
  }
  if (expression.kind === "LambdaExpr" && expectedType.kind === "Function") {
    recordResolvedExpectedType(context, expression, expectedType);
    return checkLambdaExpression(
      context,
      expression,
      scope,
      expectedType,
      (body, bodyScope, expectedBodyType) => expectedBodyType
        ? host.checkExpressionForExpectedType(context, body, bodyScope, expectedBodyType)
        : host.checkExpression(context, body, bodyScope)
    );
  }
  if (expression.kind === "ConditionalExpr") {
    recordResolvedExpectedType(context, expression, expectedType);
    host.checkExpression(context, expression.condition, scope);
    const trueType = host.checkExpressionForExpectedType(
      context,
      expression.whenTrue,
      scopeForTruthyCondition(scope, expression.condition),
      expectedType
    );
    const falseType = host.checkExpressionForExpectedType(
      context,
      expression.whenFalse,
      scope,
      expectedType
    );
    return expectedType.kind === "TextureRef" || expectedType.kind === "TextureVariable"
      ? mergeTextureRefBranchTypes([trueType, falseType])
      : combineRsglTypes(
        [trueType, falseType],
        false,
        inferredUnionBudgetOptions(context.diagnostics, expression.range)
      );
  }
  if (expression.kind === "MatchExpr") {
    recordResolvedExpectedType(context, expression, expectedType);
    const matchedType = host.checkExpression(context, expression.expression, scope);
    const armTypes = expression.arms.map(arm => {
      arm.patterns
        .filter(pattern => !isWildcardPattern(pattern))
        .forEach(pattern => host.checkExpression(context, pattern, scope));
      return host.checkExpressionForExpectedType(context, arm.value, scope, expectedType);
    });
    checkMatchExhaustiveness(expression, scope, context.diagnostics, matchedType);
    return expectedType.kind === "TextureRef" || expectedType.kind === "TextureVariable"
      ? mergeTextureRefBranchTypes(armTypes)
      : combineRsglTypes(
        armTypes,
        false,
        inferredUnionBudgetOptions(context.diagnostics, expression.range)
      );
  }
  if (expression.kind === "ObjectExpr") {
    const contextualObject = selectContextualObjectArm(expression, expectedType, scope);
    if (contextualObject) {
      recordResolvedExpectedType(context, expression, contextualObject.type);
      if (contextualObject.ambiguous) {
        context.diagnostics.push(diagnostic(
          "rsgl.ambiguousRecordUnion",
          "Record literal does not select a unique union arm; add a literal discriminator or an explicit intermediate annotation.",
          expression.range
        ));
      }
      return host.checkObjectExpression(
        context,
        expression,
        scope,
        contextualObject.type
      );
    }
  }
  const contextualListType = expression.kind === "ListExpr"
    ? selectUniqueUnionArmOfKind(expectedType, "List")
    : undefined;
  if (expression.kind === "ListExpr" && contextualListType) {
    recordResolvedExpectedType(context, expression, contextualListType);
    const elementTypes = expression.elements.map(element => {
      if (element.kind === "ListSpread") {
        const expectedSpreadType: RsglType = {
          kind: "List",
          elementType: contextualListType.elementType ?? unknownType
        };
        const diagnosticStart = context.diagnostics.length;
        const spreadType = host.checkExpressionForExpectedType(
          context,
          element.expression,
          scope,
          expectedSpreadType
        );
        const spreadElementType = resolveListSpreadElementType(context, spreadType, element);
        if (
          spreadElementType
          && !isAssignable(expectedSpreadType, spreadType)
          && context.diagnostics.length === diagnosticStart
        ) {
          host.checkAssignable(context, expectedSpreadType, spreadType, element.expression);
        }
        return spreadElementType ?? unknownType;
      }
      const actualType = host.checkExpressionForExpectedType(
        context,
        element,
        scope,
        contextualListType.elementType ?? unknownType
      );
      host.checkAssignable(
        context,
        contextualListType.elementType ?? unknownType,
        actualType,
        element
      );
      return actualType;
    });
    return inferListType(
      elementTypes,
      inferredUnionBudgetOptions(context.diagnostics, expression.range)
    );
  }
  if (expectedType.kind === "TextureRef" || expectedType.kind === "TextureVariable") {
    return checkContextualTextureRefExpression(context, expression, scope, expectedType, host);
  }
  if (
    expectedType.kind === "ResourceId"
    || expectedType.kind === "ModelId"
    || expectedType.kind === "TextureId"
  ) {
    return checkContextualResourceIdExpression(context, expression, scope, expectedType, host);
  }
  if (expectedType.kind === "Union") {
    return checkExpressionForUnionExpectedType(context, expression, scope, expectedType, host);
  }
  recordResolvedExpectedType(context, expression, expectedType);
  return host.checkExpression(context, expression, scope);
}

function checkContextualTextureRefExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  expectedType: RsglType,
  host: ContextualExpressionCheckHost
): RsglType {
  if (expression.kind === "TextureVariableLiteral") {
    recordResolvedExpectedType(context, expression, textureVariableType);
    return textureVariableType;
  }
  if (expression.kind === "StringLiteral") {
    validateTextureRefExpressionSyntax(context, expression);
    const resolvedType = expression.value.startsWith("#") ? textureVariableType : textureIdType;
    recordResolvedExpectedType(context, expression, resolvedType);
    return resolvedType;
  }
  if (expression.kind === "TemplateStringExpr") {
    const actualType = host.checkExpression(context, expression, scope);
    recordResolvedExpectedType(context, expression, textureRefType);
    return mayContainTextureVariable(actualType) ? actualType : textureRefType;
  }
  if (expression.kind === "ResourceLocationExpr") {
    validateResourceLocationValue(context, expression.value, expression.range);
    recordResolvedExpectedType(context, expression, textureIdType);
    return textureIdType;
  }
  const actualType = host.checkExpression(context, expression, scope);
  if (expectedType.kind === "TextureRef" && isStringLikeType(actualType)) {
    recordResolvedExpectedType(context, expression, textureRefType);
    return textureRefType;
  }
  const resolvedType = actualType.kind === "TextureId" || actualType.kind === "TextureVariable"
    ? actualType
    : expectedType;
  recordResolvedExpectedType(context, expression, resolvedType);
  return actualType;
}

/** Preserves source branch order for precise TextureRef mismatch diagnostics. */
function mergeTextureRefBranchTypes(types: readonly RsglType[]): RsglType {
  const options: RsglType[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    const candidates = type.kind === "Union" ? type.options ?? [] : [type];
    for (const candidate of candidates) {
      const key = rsglTypeKey(candidate);
      if (!seen.has(key)) {
        seen.add(key);
        options.push(candidate);
      }
    }
  }
  if (options.length === 0) {
    return unknownType;
  }
  return options.length === 1 ? options[0] : { kind: "Union", options };
}

function checkContextualResourceIdExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  expectedType: RsglType,
  host: ContextualExpressionCheckHost
): RsglType {
  if (expression.kind === "StringLiteral") {
    validateContextualResourceLiteral(context, expression);
    recordResolvedExpectedType(context, expression, expectedType);
    return expectedType;
  }
  if (expression.kind === "TemplateStringExpr") {
    const actualType = host.checkExpression(context, expression, scope);
    recordResolvedExpectedType(context, expression, expectedType);
    return mayContainTextureVariable(actualType) ? actualType : expectedType;
  }
  if (expression.kind === "ResourceLocationExpr") {
    validateResourceLocationValue(context, expression.value, expression.range);
    recordResolvedExpectedType(context, expression, expectedType);
    return expectedType;
  }
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    recordResolvedExpectedType(context, expression, expectedType);
    return expectedType;
  }

  const actualType = host.checkExpression(context, expression, scope);
  recordResolvedExpectedType(context, expression, expectedType);
  return isStringLikeType(actualType) ? expectedType : actualType;
}

function checkExpressionForUnionExpectedType(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  expectedType: RsglType,
  host: ContextualExpressionCheckHost
): RsglType {
  const options = expectedType.options ?? [];
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    const shorthandCandidates = contextualResourceUnionCandidates(options, expression);
    if (shorthandCandidates.length > 0) {
      return resolveContextualResourceUnion(
        context,
        expression,
        scope,
        expectedType,
        shorthandCandidates,
        unknownType,
        false,
        host
      );
    }
  }

  const actualType = host.checkExpression(context, expression, scope);
  const assignableOptions = options.filter(option => isAssignable(option, actualType));
  const exactOptions = assignableOptions.filter(option =>
    rsglTypeKey(option) === rsglTypeKey(actualType)
    || option.kind === actualType.kind
  );
  if (exactOptions.length === 1) {
    recordResolvedExpectedType(context, expression, exactOptions[0]);
    return actualType;
  }
  if (exactOptions.length === 0 && assignableOptions.length === 1) {
    recordResolvedExpectedType(context, expression, assignableOptions[0]);
    return actualType;
  }
  if (assignableOptions.length > 0) {
    recordResolvedExpectedType(context, expression, expectedType);
    return actualType;
  }

  if (isContextualResourceConversionSource(expression, actualType)) {
    const candidates = contextualResourceUnionCandidates(options, expression);
    if (candidates.length > 0) {
      return resolveContextualResourceUnion(
        context,
        expression,
        scope,
        expectedType,
        candidates,
        actualType,
        true,
        host
      );
    }
  }

  recordResolvedExpectedType(context, expression, expectedType);
  return actualType;
}

function resolveContextualResourceUnion(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  expectedType: RsglType,
  candidates: readonly RsglType[],
  actualType: RsglType,
  alreadyChecked: boolean,
  host: ContextualExpressionCheckHost
): RsglType {
  if (candidates.length > 1) {
    context.diagnostics.push(diagnostic(
      "rsgl.ambiguousResourceIdContext",
      `Resource reference has multiple possible contextual types (${candidates.map(formatType).join(" | ")}); use resource_id(...), model_id(...), or texture_id(...) to choose one.`,
      expression.range
    ));
    recordResolvedExpectedType(context, expression, expectedType);
    return expectedType;
  }
  const selected = candidates[0];
  if (!alreadyChecked) {
    return selected.kind === "TextureRef" || selected.kind === "TextureVariable"
      ? checkContextualTextureRefExpression(context, expression, scope, selected, host)
      : checkContextualResourceIdExpression(context, expression, scope, selected, host);
  }
  return contextualizeCheckedResourceExpression(context, expression, selected, actualType);
}

function contextualizeCheckedResourceExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  expectedType: RsglType,
  actualType: RsglType
): RsglType {
  if (expectedType.kind === "TextureRef" || expectedType.kind === "TextureVariable") {
    if (expression.kind === "TextureVariableLiteral") {
      recordResolvedExpectedType(context, expression, textureVariableType);
      return textureVariableType;
    }
    if (expression.kind === "StringLiteral") {
      validateTextureRefExpressionSyntax(context, expression);
      const resolvedType = expression.value.startsWith("#") ? textureVariableType : textureIdType;
      recordResolvedExpectedType(context, expression, resolvedType);
      return resolvedType;
    }
    if (expression.kind === "ResourceLocationExpr") {
      recordResolvedExpectedType(context, expression, textureIdType);
      return textureIdType;
    }
    recordResolvedExpectedType(context, expression, expectedType);
    return expectedType.kind === "TextureRef" && isStringLikeType(actualType)
      ? textureRefType
      : actualType;
  }

  if (expression.kind === "StringLiteral") {
    validateContextualResourceLiteral(context, expression);
  }
  recordResolvedExpectedType(context, expression, expectedType);
  return expectedType;
}

function contextualResourceUnionCandidates(
  options: readonly RsglType[],
  expression: ExprNode
): RsglType[] {
  const textureVariableSyntax = expression.kind === "TextureVariableLiteral"
    || (expression.kind === "StringLiteral" && expression.value.startsWith("#"));
  return options.filter(option => textureVariableSyntax
    ? option.kind === "TextureRef" || option.kind === "TextureVariable"
    : option.kind === "ResourceId"
      || option.kind === "ModelId"
      || option.kind === "TextureId"
      || option.kind === "TextureRef");
}

function isContextualResourceConversionSource(expression: ExprNode, actualType: RsglType): boolean {
  return expression.kind === "TextureVariableLiteral"
    || expression.kind === "StringLiteral"
    || expression.kind === "TemplateStringExpr"
    || expression.kind === "ResourceLocationExpr"
    || isStringLikeType(actualType);
}

function isStringLikeType(type: RsglType): boolean {
  if (type.kind === "String") {
    return true;
  }
  return type.kind === "Union"
    && (type.options?.length ?? 0) > 0
    && (type.options ?? []).every(option => option.kind === "String");
}

function selectUniqueUnionArmOfKind(
  expectedType: RsglType,
  kind: RsglType["kind"]
): RsglType | undefined {
  if (expectedType.kind === kind) {
    return expectedType;
  }
  if (expectedType.kind !== "Union") {
    return undefined;
  }
  const candidates = (expectedType.options ?? []).filter(option => option.kind === kind);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function recordResolvedExpectedType(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  expectedType: RsglType
): void {
  if (expectedType.kind !== "Unknown") {
    context.recordResolvedExpectedType?.(expression, expectedType);
  }
}
