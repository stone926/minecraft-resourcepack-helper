import { parseMinecraftResourceId } from "../../../mc-assets/src";
import {
  ExprNode,
  LetDeclNode,
  ObjectExprNode,
  RsglNode,
  TextRange
} from "../parser";
import { checkCallExpression, RsglCallCheckHost } from "./callChecking";
import {
  checkContextualObject,
  ContextualObjectCheckHost,
  selectContextualObjectArm
} from "./contextualObjectChecking";
import { diagnostic } from "./diagnostics";
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
  inferListType
} from "./typeNormalization";
import { formatType, isAssignable } from "./typeRelations";
import { inferredUnionBudgetOptions } from "./unionBudget";
import {
  identifierName,
  inferLiteralType,
  jsonType,
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

export type { RsglExpressionCheckContext } from "./expressionCheckContext";

const callCheckHost: RsglCallCheckHost = {
  checkExpression,
  checkExpressionForExpectedType,
  checkAssignable
};

const contextualObjectCheckHost: ContextualObjectCheckHost = {
  checkExpression,
  checkExpressionForExpectedType,
  checkAssignable
};

export function checkExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): RsglType {
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
    return resourceIdType;
  }
  if (expression.kind === "ListExpr") {
    const elementTypes = expression.elements.map(element => checkExpression(context, element, scope));
    return inferListType(elementTypes, inferredUnionBudgetOptions(context.diagnostics, expression.range));
  }
  if (expression.kind === "ObjectExpr") {
    return checkObject(context, expression, scope);
  }
  if (expression.kind === "StateKeySugar") {
    for (const entry of expression.entries) {
      if (entry.key.kind === "DynamicKey") {
        checkExpression(context, entry.key.expression, scope);
      }
      checkStateKeyValueExpression(context, entry.value, scope);
    }
    return jsonType;
  }
  if (expression.kind === "ModelApplySugar") {
    checkResourceIdExpression(context, expression.model, scope);
    for (const property of expression.properties) {
      checkExpression(context, property.value, scope);
    }
    return jsonType;
  }
  if (expression.kind === "RandomApply") {
    for (const entry of expression.entries) {
      checkExpression(context, entry, scope);
    }
    return jsonType;
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
    checkExpression(context, expression.operand, scope);
    return unaryOperatorResultType(expression.operator);
  }
  if (expression.kind === "BinaryExpr") {
    checkExpression(context, expression.left, scope);
    checkExpression(context, expression.right, scope);
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
    checkExpression(context, expression.condition, scope);
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

export function checkResourceIdExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): RsglType {
  if (expression.kind === "StringLiteral") {
    if (expression.value.startsWith("#")) {
      context.diagnostics.push(diagnostic(
        "rsgl.textureVariableInvalidContext",
        `Texture variable '${expression.value}' is only valid where TextureRef is expected.`,
        expression.range
      ));
      return textureVariableType;
    }
    validateResourceLocationValue(context, expression.value, expression.range);
    return resourceIdType;
  }
  if (expression.kind === "TemplateStringExpr") {
    checkExpression(context, expression, scope);
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
  if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
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
  if (expression.kind === "LambdaExpr" && expectedType.kind === "Function") {
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
  if (expression.kind === "ObjectExpr") {
    const contextualObject = selectContextualObjectArm(expression, expectedType, scope);
    if (contextualObject) {
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
  if (expression.kind === "ListExpr" && expectedType.kind === "List") {
    const elementTypes = expression.elements.map(element => {
      const actualType = checkExpressionForExpectedType(
        context,
        element,
        scope,
        expectedType.elementType ?? unknownType
      );
      checkAssignable(context, expectedType.elementType ?? unknownType, actualType, element);
      return actualType;
    });
    return inferListType(elementTypes, inferredUnionBudgetOptions(context.diagnostics, expression.range));
  }
  if (expectedType.kind === "TextureRef" || expectedType.kind === "TextureVariable") {
    return checkTextureRefExpression(context, expression, scope);
  }
  if (
    expectedType.kind === "ResourceId"
    || expectedType.kind === "ModelId"
    || expectedType.kind === "TextureId"
  ) {
    return checkResourceIdExpression(context, expression, scope);
  }
  return checkExpression(context, expression, scope);
}

export function checkTextureRefExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  if (expression.kind === "StringLiteral") {
    validateTextureRefExpressionSyntax(context, expression);
    return expression.value.startsWith("#") ? textureVariableType : textureIdType;
  }
  if (expression.kind === "TemplateStringExpr") {
    checkExpression(context, expression, scope);
    return textureRefType;
  }
  if (expression.kind === "ResourceLocationExpr") {
    checkResourceIdExpression(context, expression, scope);
    return textureIdType;
  }
  if (expression.kind === "ConditionalExpr") {
    checkExpression(context, expression.condition, scope);
    return mergeTextureRefBranchTypes([
      checkTextureRefExpression(context, expression.whenTrue, scope),
      checkTextureRefExpression(context, expression.whenFalse, scope)
    ]);
  }
  if (expression.kind === "MatchExpr") {
    const matchedType = checkExpression(context, expression.expression, scope);
    const armTypes = expression.arms.map(arm => {
      arm.patterns
        .filter(pattern => !isWildcardPattern(pattern))
        .forEach(pattern => checkExpression(context, pattern, scope));
      return checkTextureRefExpression(context, arm.value, scope);
    });
    checkMatchExhaustiveness(expression, scope, context.diagnostics, matchedType);
    return mergeTextureRefBranchTypes(armTypes);
  }
  return checkExpression(context, expression, scope);
}

/** Preserves incompatible result branches instead of widening them to Any. */
function mergeTextureRefBranchTypes(types: readonly RsglType[]): RsglType {
  const options: RsglType[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    const candidates = type.kind === "Union" ? type.options ?? [] : [type];
    for (const candidate of candidates) {
      const key = formatType(candidate);
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
    expression.elements.forEach(element => checkEquipmentLayerNameExpression(context, element, scope));
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
  const actualType = checkExpressionForExpectedType(context, statement.value, scope, expectedType);
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
  expectedType?: RsglType
): RsglType {
  return checkContextualObject(
    context,
    expression,
    scope,
    contextualObjectCheckHost,
    expectedType
  );
}

export function checkAssignable(context: RsglExpressionCheckContext, expected: RsglType, actual: RsglType, node: RsglNode): void {
  if (containsMissingType(actual)) {
    // The member/index checker already emitted optionalFieldMayBeMissing at
    // the access. A second generic mismatch at the enclosing sink obscures
    // the actionable guard diagnostic.
    return;
  }
  if (!isAssignable(expected, actual)) {
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

function checkStateKeyValueExpression(context: RsglExpressionCheckContext, expression: ExprNode, scope: RsglScope): RsglType {
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    return stringType;
  }
  return checkExpression(context, expression, scope);
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
  if (expression.object.kind !== "ListExpr" || expression.index.kind !== "NumberLiteral") {
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
