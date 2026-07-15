import { parseMinecraftResourceId } from "../../../mc-assets/src";
import {
  resourceValueKindForTypeKind,
  typeKindForResourceValueKind,
  type RsglResourceValueKind
} from "../resourceIdSemantics";
import {
  ExprNode,
  LetDeclNode,
  ListExprNode,
  ObjectExprNode,
  RsglNode,
  TextRange
} from "../parser";
import { checkCallExpression, RsglCallCheckHost } from "./callChecking";
import { isCollectionBuiltinName } from "./collectionBuiltinInference";
import {
  checkContextualObject,
  ContextualObjectCheckOptions,
  ContextualObjectCheckHost,
  selectContextualObjectArm
} from "./contextualObjectChecking";
import { diagnostic } from "./diagnostics";
import { checkBlockstatePredicate } from "./blockstatePredicateChecker";
import { checkModuleNamespaceMember } from "./moduleNamespace";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { checkMatchExhaustiveness, finiteStringDomain, isWildcardPattern } from "./domainChecks";
import { checkLambdaExpression, lambdaSignature } from "./lambdaTyping";
import { binaryOperatorResultType, unaryOperatorResultType } from "./operatorTypes";
import { lookup } from "./scopes";
import { scopeForTruthyCondition } from "./typeNarrowing";
import {
  resolveIndexType,
  resolveMemberType,
  staticIndexKey,
  StructuralAccessIssue
} from "./structuralTypes";
import {
  combineRsglTypes,
  inferListType,
  rsglTypeKey
} from "./typeNormalization";
import { formatType, isAssignable } from "./typeRelations";
import { inferredUnionBudgetOptions } from "./unionBudget";
import {
  identifierName,
  inferLiteralType,
  neverType,
  numberType,
  resourceIdType,
  RsglScope,
  RsglType,
  stringType,
  textureIdType,
  textureRefType,
  textureVariableType,
  typeFromAnnotation,
  unknownType
} from "./types";

const callCheckHost: RsglCallCheckHost = {
  checkExpression,
  checkExpressionForExpectedType,
  checkAssignable,
  checkContextualObjectExpression: (context, expression, scope, expectedType) =>
    checkObject(context, expression, scope, expectedType, { preserveInferredShape: true })
};

const contextualObjectCheckHost: ContextualObjectCheckHost = {
  checkExpression,
  checkExpressionForExpectedType,
  checkAssignable
};

export function checkExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  const type = checkExpressionCore(context, expression, scope);
  context.recordResolvedExpressionType?.(expression, type);
  return type;
}

/** Checks an ordinary compile-time branch condition and rejects runtime state predicates. */
export function checkCompileTimeCondition(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  const type = checkExpression(context, expression, scope);
  if (containsStatePredicate(type)) {
    context.diagnostics.push(diagnostic(
      "rsgl.statePredicateCompileTimeCondition",
      "StatePredicate describes runtime block state and cannot control compile-time if/conditional execution.",
      expression.range
    ));
  }
  return type;
}

function checkExpressionCore(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): RsglType {
  if (expression.kind === "IdentifierExpr") {
    const symbol = lookup(scope, expression.name.text);
    context.references.push({ name: expression.name.text, range: expression.range, symbol });
    if (!symbol) {
      if (!context.isUndefinedSymbolDiagnosticSuppressed?.(expression.name.text)) {
        context.diagnostics.push(diagnostic("rsgl.undefinedSymbol", `Undefined RSGL symbol '${expression.name.text}'.`, expression.range));
      }
      return unknownType;
    }
    return symbol.type;
  }
  if (expression.kind === "ResourceLocationExpr") {
    validateResourceLocationValue(context, expression.value, expression.range);
    // A resource-location token is ordinary text until an annotation or a
    // known sink supplies the nominal ID kind. This mirrors evaluator
    // behavior: unannotated lets/records/lists keep a string and are converted
    // exactly once at their eventual contextual boundary.
    return stringType;
  }
  if (expression.kind === "ListExpr") {
    return checkListExpression(context, expression, scope);
  }
  if (expression.kind === "ObjectExpr") {
    return checkObject(context, expression, scope);
  }
  if (expression.kind === "CallExpr") {
    return checkCallExpression(context, expression, scope, callCheckHost);
  }
  if (expression.kind === "LambdaExpr") {
    return checkLambdaExpression(
      context,
      expression,
      scope,
      undefined,
      (body, bodyScope) => checkExpression(context, body, bodyScope)
    );
  }
  if (expression.kind === "ForInExpr") {
    context.diagnostics.push(diagnostic("rsgl.invalidForInExpression", "'name in iterable' generator expressions are only valid as seq arguments.", expression.range));
    checkExpression(context, expression.iterable, scope);
    return unknownType;
  }
  if (expression.kind === "MemberExpr") {
    const objectType = checkExpression(context, expression.object, scope);
    const namespaceMember = checkModuleNamespaceMember(
      context,
      expression,
      objectType,
      "value"
    );
    if (namespaceMember) {
      return namespaceMember.member?.symbol.type ?? unknownType;
    }
    const result = resolveMemberType(
      objectType,
      expression.property.text,
      inferredUnionBudgetOptions(context.diagnostics, expression.range)
    );
    reportStructuralAccessIssues(context, result.issues, expression.property);
    reportOptionalFieldAccess(context, result.type, expression.property);
    return result.type;
  }
  if (expression.kind === "IndexExpr") {
    const objectType = checkExpression(context, expression.object, scope);
    const indexType = checkExpression(context, expression.index, scope);
    const result = resolveIndexType(
      objectType,
      indexType,
      staticIndexKey(expression.index),
      inferredUnionBudgetOptions(context.diagnostics, expression.range)
    );
    reportStructuralAccessIssues(context, result.issues, expression.index);
    if (!result.issues.some(issue => issue.kind === "dynamicKeyMayBeMissing")) {
      reportOptionalFieldAccess(context, result.type, expression.index);
    }
    reportStaticListIndexBounds(context, expression);
    return result.type;
  }
  if (expression.kind === "UnaryExpr") {
    const operandType = checkExpression(context, expression.operand, scope);
    if (containsStatePredicate(operandType)) {
      context.diagnostics.push(diagnostic(
        "rsgl.statePredicateOutsidePredicateContext",
        "StatePredicate operators are only valid where a StatePredicate is expected.",
        expression.range
      ));
    }
    return unaryOperatorResultType(expression.operator);
  }
  if (expression.kind === "BinaryExpr") {
    const leftType = checkExpression(context, expression.left, scope);
    const rightType = checkExpression(context, expression.right, scope);
    if (expression.operator === "in" || expression.operator === "not in") {
      context.diagnostics.push(diagnostic(
        "rsgl.statePredicateOperatorContext",
        `'${expression.operator}' is only available in a StatePredicate expression.`,
        expression.range
      ));
      return unknownType;
    }
    if (containsStatePredicate(leftType) || containsStatePredicate(rightType)) {
      context.diagnostics.push(diagnostic(
        "rsgl.statePredicateOutsidePredicateContext",
        "StatePredicate operators are only valid where a StatePredicate is expected.",
        expression.range
      ));
      return unknownType;
    }
    return binaryOperatorResultType(expression.operator);
  }
  if (expression.kind === "RangeExpr") {
    const startType = checkExpression(context, expression.startExpr, scope);
    const endType = checkExpression(context, expression.endExpr, scope);
    checkAssignable(context, numberType, startType, expression.startExpr);
    checkAssignable(context, numberType, endType, expression.endExpr);
    return { kind: "Range", elementType: numberType };
  }
  if (expression.kind === "ConditionalExpr") {
    checkCompileTimeCondition(context, expression.condition, scope);
    const trueType = checkExpression(
      context,
      expression.whenTrue,
      scopeForTruthyCondition(scope, expression.condition)
    );
    const falseType = checkExpression(context, expression.whenFalse, scope);
    return combineRsglTypes(
      [trueType, falseType],
      false,
      inferredUnionBudgetOptions(context.diagnostics, expression.range)
    );
  }
  if (expression.kind === "MatchExpr") {
    const matchedType = checkExpression(context, expression.expression, scope);
    const armTypes = expression.arms.map(arm => {
      arm.patterns
        .filter(pattern => !isWildcardPattern(pattern))
        .forEach(pattern => checkExpression(context, pattern, scope));
      return checkExpression(context, arm.value, scope);
    });
    checkMatchExhaustiveness(expression, scope, context.diagnostics, matchedType);
    return combineRsglTypes(
      armTypes,
      false,
      inferredUnionBudgetOptions(context.diagnostics, expression.range)
    );
  }
  if (expression.kind === "TemplateStringExpr") {
    for (const part of expression.parts) {
      if (part.kind === "expression") {
        checkExpression(context, part.expression, scope);
      }
    }
    const finiteDomain = finiteStringDomain(expression, scope);
    return finiteDomain?.length
      ? combineRsglTypes(
        finiteDomain.map(value => ({ kind: "String", literalValue: value })),
        false,
        inferredUnionBudgetOptions(context.diagnostics, expression.range)
      )
      : stringType;
  }
  return inferLiteralType(expression);
}

function containsStatePredicate(type: RsglType): boolean {
  return type.kind === "StatePredicate"
    || (type.kind === "Union" && (type.options ?? []).some(containsStatePredicate));
}

export function checkResourceIdExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): RsglType {
  if (expression.kind === "StringLiteral") {
    validateContextualResourceLiteral(context, expression);
    return resourceIdType;
  }
  if (expression.kind === "TemplateStringExpr") {
    checkExpression(context, expression, scope);
    return resourceIdType;
  }
  if (expression.kind === "ResourceLocationExpr") {
    validateResourceLocationValue(context, expression.value, expression.range);
    return resourceIdType;
  }
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    return resourceIdType;
  }
  return checkExpression(context, expression, scope);
}

export function checkTemplateUseExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  if (
    expression.kind !== "CallExpr"
    || (
      expression.callee.kind !== "IdentifierExpr"
      && expression.callee.kind !== "MemberExpr"
    )
  ) {
    const type = checkExpression(context, expression, scope);
    context.diagnostics.push(diagnostic(
      "rsgl.functionValueCannotUse",
      "use requires a template call or a registered resource-body helper.",
      expression.range
    ));
    return type;
  }
  const type = checkCallExpression(context, expression, scope, callCheckHost, true);
  return type;
}

export function checkExpressionForExpectedType(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  expectedType: RsglType
): RsglType {
  const type = checkExpressionForExpectedTypeCore(
    context,
    expression,
    scope,
    expectedType
  );
  context.recordResolvedExpressionType?.(expression, type);
  return type;
}

function checkExpressionForExpectedTypeCore(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  expectedType: RsglType
): RsglType {
  if (expectedType.kind === "StatePredicate") {
    return checkBlockstatePredicate(context, expression, scope);
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
      callCheckHost,
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
        ? checkExpressionForExpectedType(context, body, bodyScope, expectedBodyType)
        : checkExpression(context, body, bodyScope)
    );
  }
  if (expression.kind === "ConditionalExpr") {
    recordResolvedExpectedType(context, expression, expectedType);
    checkExpression(context, expression.condition, scope);
    const trueType = checkExpressionForExpectedType(
      context,
      expression.whenTrue,
      scopeForTruthyCondition(scope, expression.condition),
      expectedType
    );
    const falseType = checkExpressionForExpectedType(
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
    const matchedType = checkExpression(context, expression.expression, scope);
    const armTypes = expression.arms.map(arm => {
      arm.patterns
        .filter(pattern => !isWildcardPattern(pattern))
        .forEach(pattern => checkExpression(context, pattern, scope));
      return checkExpressionForExpectedType(context, arm.value, scope, expectedType);
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
      return checkObject(context, expression, scope, contextualObject.type);
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
        const spreadType = checkExpressionForExpectedType(
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
          checkAssignable(context, expectedSpreadType, spreadType, element.expression);
        }
        return spreadElementType ?? unknownType;
      }
      const actualType = checkExpressionForExpectedType(
        context,
        element,
        scope,
        contextualListType.elementType ?? unknownType
      );
      checkAssignable(context, contextualListType.elementType ?? unknownType, actualType, element);
      return actualType;
    });
    return inferListType(elementTypes, inferredUnionBudgetOptions(context.diagnostics, expression.range));
  }
  if (expectedType.kind === "TextureRef" || expectedType.kind === "TextureVariable") {
    return checkContextualTextureRefExpression(context, expression, scope, expectedType);
  }
  if (
    expectedType.kind === "ResourceId"
    || expectedType.kind === "ModelId"
    || expectedType.kind === "TextureId"
  ) {
    return checkContextualResourceIdExpression(context, expression, scope, expectedType);
  }
  if (expectedType.kind === "Union") {
    return checkExpressionForUnionExpectedType(context, expression, scope, expectedType);
  }
  recordResolvedExpectedType(context, expression, expectedType);
  return checkExpression(context, expression, scope);
}

export function checkTextureRefExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  return checkExpressionForExpectedType(context, expression, scope, textureRefType);
}

function checkContextualTextureRefExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  expectedType: RsglType
): RsglType {
  if (expression.kind === "StringLiteral") {
    validateTextureRefExpressionSyntax(context, expression);
    const resolvedType = expression.value.startsWith("#") ? textureVariableType : textureIdType;
    recordResolvedExpectedType(context, expression, resolvedType);
    return resolvedType;
  }
  if (expression.kind === "TemplateStringExpr") {
    checkExpression(context, expression, scope);
    recordResolvedExpectedType(context, expression, textureRefType);
    return textureRefType;
  }
  if (expression.kind === "ResourceLocationExpr") {
    validateResourceLocationValue(context, expression.value, expression.range);
    recordResolvedExpectedType(context, expression, textureIdType);
    return textureIdType;
  }
  const actualType = checkExpression(context, expression, scope);
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
  expectedType: RsglType
): RsglType {
  if (expression.kind === "StringLiteral") {
    validateContextualResourceLiteral(context, expression);
    recordResolvedExpectedType(context, expression, expectedType);
    return expectedType;
  }
  if (expression.kind === "TemplateStringExpr") {
    checkExpression(context, expression, scope);
    recordResolvedExpectedType(context, expression, expectedType);
    return expectedType;
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

  const actualType = checkExpression(context, expression, scope);
  recordResolvedExpectedType(context, expression, expectedType);
  return isStringLikeType(actualType) ? expectedType : actualType;
}

function checkExpressionForUnionExpectedType(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  expectedType: RsglType
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
        false
      );
    }
  }

  const actualType = checkExpression(context, expression, scope);
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
        true
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
  alreadyChecked: boolean
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
      ? checkContextualTextureRefExpression(context, expression, scope, selected)
      : checkContextualResourceIdExpression(context, expression, scope, selected);
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
  const textureVariableSyntax = expression.kind === "StringLiteral" && expression.value.startsWith("#");
  return options.filter(option => textureVariableSyntax
    ? option.kind === "TextureRef" || option.kind === "TextureVariable"
    : option.kind === "ResourceId"
      || option.kind === "ModelId"
      || option.kind === "TextureId"
      || option.kind === "TextureRef");
}

function isContextualResourceConversionSource(expression: ExprNode, actualType: RsglType): boolean {
  return expression.kind === "StringLiteral"
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

function validateContextualResourceLiteral(
  context: Pick<RsglExpressionCheckContext, "diagnostics">,
  expression: Extract<ExprNode, { kind: "StringLiteral" }>
): void {
  if (expression.value.startsWith("#")) {
    context.diagnostics.push(diagnostic(
      "rsgl.textureVariableInvalidContext",
      `Texture variable '${expression.value}' is only valid where TextureRef is expected.`,
      expression.range
    ));
    return;
  }
  validateResourceLocationValue(context, expression.value, expression.range);
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

/** Runs only the syntax checks that depend on a value being used as TextureRef. */
export function validateTextureRefExpressionSyntax(
  context: Pick<RsglExpressionCheckContext, "diagnostics">,
  expression: ExprNode
): void {
  if (expression.kind !== "StringLiteral") {
    return;
  }
  if (expression.value.startsWith("#")) {
    if (!/^#[A-Za-z0-9_.\-/]+$/.test(expression.value)) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidTextureVariable",
        `Invalid texture variable '${expression.value}'.`,
        expression.range
      ));
    }
    return;
  }
  validateResourceLocationValue(context, expression.value, expression.range);
}

export function checkEquipmentLayerListExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): void {
  if (expression.kind === "ListExpr") {
    expression.elements.forEach(element => {
      if (element.kind === "ListSpread") {
        const spreadType = checkExpression(context, element.expression, scope);
        const elementType = resolveListSpreadElementType(context, spreadType, element);
        if (elementType) {
          checkAssignable(context, stringType, elementType, element);
        }
      } else {
        checkEquipmentLayerNameExpression(context, element, scope);
      }
    });
    return;
  }
  checkEquipmentLayerNameExpression(context, expression, scope);
}

export function checkEquipmentLayerNameExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): void {
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    return;
  }
  checkExpression(context, expression, scope);
}

export function checkStringEnumLikeExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): void {
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    return;
  }
  checkExpression(context, expression, scope);
}

export function checkLocalLetDecl(context: RsglExpressionCheckContext, statement: LetDeclNode, scope: RsglScope): void {
  const expectedType = typeFromAnnotation(statement.typeAnnotation, scope, context.diagnostics);
  const actualType = expectedType.kind === "StatePredicate"
    ? checkBlockstatePredicate(context, statement.value, scope)
    : checkExpressionForExpectedType(context, statement.value, scope, expectedType);
  checkAssignable(context, expectedType, actualType, statement.value);
  const declaredType = statement.typeAnnotation ? expectedType : actualType;
  context.defineIdentifier(scope, statement.name, "variable", declaredType, statement);
  const name = identifierName(statement.name);
  const symbol = name ? lookup(scope, name) : undefined;
  if (symbol && symbol.node === statement) {
    symbol.finiteDomain = finiteStringDomain(statement.value, scope) ?? undefined;
    if (statement.value.kind === "LambdaExpr") {
      symbol.signature = lambdaSignature(statement.value, declaredType);
    }
  }
}

export function checkObject(
  context: RsglExpressionCheckContext,
  expression: ObjectExprNode,
  scope: RsglScope,
  expectedType?: RsglType,
  options?: ContextualObjectCheckOptions
): RsglType {
  return checkContextualObject(
    context,
    expression,
    scope,
    contextualObjectCheckHost,
    expectedType,
    options
  );
}

function checkListExpression(
  context: RsglExpressionCheckContext,
  expression: ListExprNode,
  scope: RsglScope
): RsglType {
  const elementTypes: RsglType[] = [];
  for (const element of expression.elements) {
    if (element.kind !== "ListSpread") {
      elementTypes.push(checkExpression(context, element, scope));
      continue;
    }
    const spreadType = checkExpression(context, element.expression, scope);
    const spreadElementType = resolveListSpreadElementType(context, spreadType, element);
    if (spreadElementType) {
      elementTypes.push(spreadElementType);
    }
  }
  return inferListType(
    elementTypes,
    inferredUnionBudgetOptions(context.diagnostics, expression.range)
  );
}

export function resolveListSpreadElementType(
  context: RsglExpressionCheckContext,
  spreadType: RsglType,
  spread: RsglNode
): RsglType | undefined {
  if (spreadType.kind === "List") {
    return spreadType.elementType ?? unknownType;
  }
  if (spreadType.kind === "Union") {
    const options = spreadType.options ?? [];
    if (options.every(option =>
      option.kind === "List"
      || option.kind === "Unknown"
      || option.kind === "Any"
      || option.kind === "Never"
    )) {
      const elementTypes = options.flatMap(option => {
        if (option.kind === "List") {
          return [option.elementType ?? unknownType];
        }
        if (option.kind === "Never") {
          return [];
        }
        return [option];
      });
      return combineRsglTypes(
        elementTypes.length > 0 ? elementTypes : [neverType],
        false,
        inferredUnionBudgetOptions(context.diagnostics, spread.range)
      );
    }
  }
  if (spreadType.kind === "Unknown" || spreadType.kind === "Any") {
    return spreadType;
  }
  context.diagnostics.push(diagnostic(
    "rsgl.invalidListSpread",
    `List spread requires a List value, got ${formatType(spreadType)}.`,
    spread.range
  ));
  return undefined;
}

export function checkAssignable(context: RsglExpressionCheckContext, expected: RsglType, actual: RsglType, node: RsglNode): void {
  if (containsMissingType(actual)) {
    // The member/index checker already emitted optionalFieldMayBeMissing at
    // the access. A second generic mismatch at the enclosing sink obscures
    // the actionable guard diagnostic.
    return;
  }
  if (expected.kind === "Json" && containsModuleNamespaceType(actual)) {
    context.diagnostics.push(diagnostic(
      "rsgl.moduleNamespaceValueNotSerializable",
      "A module namespace cannot be serialized as JSON; select one of its exported values.",
      node.range
    ));
    return;
  }
  if (!isAssignable(expected, actual)) {
    const expectedResourceKind = singleExpectedResourceValueKind(expected);
    const actualResourceKind = resourceValueKindForTypeKind(actual.kind);
    if (expectedResourceKind && (actualResourceKind || actual.kind === "TextureVariable")) {
      context.diagnostics.push(diagnostic(
        "rsgl.resourceIdKindMismatch",
        `${actualResourceKind ? typeKindForResourceValueKind(actualResourceKind) : "TextureVariable"} cannot be used where ${typeKindForResourceValueKind(expectedResourceKind)} is required.`,
        node.range
      ));
      return;
    }
    context.diagnostics.push(diagnostic(
      "rsgl.typeMismatch",
      `Expected ${formatType(expected)}, got ${formatType(actual)}.`,
      node.range
    ));
  }
}

export function validateResourceLocationLike(context: RsglExpressionCheckContext, expression: ExprNode): void {
  if (expression.kind === "ResourceLocationExpr") {
    validateResourceLocationValue(context, expression.value, expression.range);
  }
}

function validateResourceLocationValue(
  context: Pick<RsglExpressionCheckContext, "diagnostics">,
  value: string,
  range: TextRange
): void {
  const parsed = parseMinecraftResourceId(value);
  if (value.includes(":") && !parsed.isValid) {
    context.diagnostics.push(diagnostic("rsgl.invalidResourceLocation", `Invalid resource location '${value}'.`, range));
  } else if (!parsed.isValid) {
    context.diagnostics.push(diagnostic("rsgl.invalidResourcePath", `Invalid resource path '${value}'.`, range));
  }
}

function reportStructuralAccessIssues(
  context: Pick<RsglExpressionCheckContext, "diagnostics">,
  issues: readonly StructuralAccessIssue[],
  node: RsglNode
): void {
  for (const issue of issues) {
    if (issue.kind === "unknownProperty") {
      const suggestion = issue.suggestion ? ` Did you mean '${issue.suggestion}'?` : "";
      context.diagnostics.push(diagnostic(
        "rsgl.unknownRecordField",
        `Property '${issue.property}' does not exist on ${formatType(issue.actualType)}.${suggestion}`,
        node.range
      ));
    } else if (issue.kind === "invalidMemberTarget") {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidMemberAccess",
        `Cannot access property '${issue.property}' on ${formatType(issue.actualType)}.`,
        node.range
      ));
    } else if (issue.kind === "invalidIndexTarget") {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidIndexAccess",
        `Type ${formatType(issue.actualType)} cannot be indexed.`,
        node.range
      ));
    } else if (issue.kind === "dynamicKeyMayBeMissing") {
      context.diagnostics.push(diagnostic(
        "rsgl.optionalFieldMayBeMissing",
        "A dynamic key may not name a field in this closed record; use a finite literal key type or an open Json value.",
        node.range
      ));
    } else {
      const expected = issue.targetKind === "Object" ? "a scalar object key" : "Number";
      context.diagnostics.push(diagnostic(
        "rsgl.invalidIndexType",
        `${issue.targetKind} indices require ${expected}, got ${formatType(issue.actualType)}.`,
        node.range
      ));
    }
  }
}

function containsModuleNamespaceType(type: RsglType, seen = new Set<RsglType>()): boolean {
  if (type.kind === "ModuleNamespace") {
    return true;
  }
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);
  if (type.kind === "Union") {
    return (type.options ?? []).some(option => containsModuleNamespaceType(option, seen));
  }
  if (type.kind === "List") {
    return type.elementType
      ? containsModuleNamespaceType(type.elementType, seen)
      : false;
  }
  if (type.kind === "Object") {
    return Array.from(type.properties?.values() ?? [])
      .some(property => containsModuleNamespaceType(property.type, seen))
      || Boolean(type.indexType && containsModuleNamespaceType(type.indexType, seen));
  }
  return false;
}

function singleExpectedResourceValueKind(type: RsglType): RsglResourceValueKind | undefined {
  const direct = resourceValueKindForTypeKind(type.kind);
  if (direct) {
    return direct;
  }
  if (type.kind === "TextureRef" || type.kind === "TextureVariable") {
    return "texture";
  }
  if (type.kind !== "Union") {
    return undefined;
  }
  const kinds = new Set(
    (type.options ?? [])
      .map(singleExpectedResourceValueKind)
      .filter((kind): kind is RsglResourceValueKind => Boolean(kind))
  );
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

function reportOptionalFieldAccess(
  context: Pick<RsglExpressionCheckContext, "diagnostics">,
  type: RsglType,
  node: RsglNode
): void {
  const mayBeMissing = type.kind === "Missing"
    || (type.kind === "Union" && (type.options ?? []).some(option => option.kind === "Missing"));
  if (mayBeMissing) {
    context.diagnostics.push(diagnostic(
      "rsgl.optionalFieldMayBeMissing",
      "Optional record field may be missing; guard the access with has(object, \"field\").",
      node.range
    ));
  }
}

function containsMissingType(type: RsglType): boolean {
  return type.kind === "Missing"
    || (type.kind === "Union" && (type.options ?? []).some(containsMissingType));
}

function reportStaticListIndexBounds(
  context: Pick<RsglExpressionCheckContext, "diagnostics">,
  expression: Extract<ExprNode, { kind: "IndexExpr" }>
): void {
  if (
    expression.object.kind !== "ListExpr"
    || expression.index.kind !== "NumberLiteral"
    || expression.object.elements.some(element => element.kind === "ListSpread")
  ) {
    return;
  }
  const index = expression.index.value;
  if (Number.isInteger(index) && index >= 0 && index < expression.object.elements.length) {
    return;
  }
  const bounds = expression.object.elements.length === 0
    ? "an empty static list"
    : `the static list bounds 0..${expression.object.elements.length - 1}`;
  context.diagnostics.push(diagnostic(
    "rsgl.indexOutOfBounds",
    `List index ${expression.index.raw} is outside ${bounds}.`,
    expression.index.range
  ));
}
