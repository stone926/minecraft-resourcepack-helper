import { resourceBodyMessages, statePredicateMessages } from "../diagnosticMessages";
import type {
  ExprNode,
  LetDeclNode,
  ObjectExprNode
} from "../parser";
import { checkCallExpression } from "./callChecking";
import {
  checkExpressionForExpectedType as checkContextualExpression,
  checkResourceIdExpression as checkContextualResourceIdExpression,
  type ContextualExpressionCheckHost
} from "./contextualExpressionChecking";
import type { ContextualObjectCheckOptions } from "./contextualObjectChecking";
import { diagnostic } from "./diagnostics";
import {
  checkBlockstatePredicateWithHost,
  type BlockstatePredicateCheckHost
} from "./blockstatePredicateChecker";
import { checkMatchExhaustiveness, finiteStringDomain, isWildcardPattern } from "./domainChecks";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { checkAssignable } from "./expressionTypeCompatibility";
import { resolveListSpreadElementType } from "./listSpreadTypes";
import { checkLambdaExpression, lambdaSignature } from "./lambdaTyping";
import { binaryOperatorResultType, unaryOperatorResultType } from "./operatorTypes";
import {
  validateResourceLocationLike,
  validateResourceLocationValue,
  validateTextureRefExpressionSyntax
} from "./resourceExpressionSyntax";
import { lookup } from "./scopes";
import {
  checkIndexExpression,
  checkListExpression,
  checkMemberExpression,
  checkObjectExpression
} from "./structuralExpressionChecking";
import { scopeForTruthyCondition } from "./typeNarrowing";
import { combineRsglTypes } from "./typeNormalization";
import { inferredUnionBudgetOptions } from "./unionBudget";
import {
  identifierName,
  inferLiteralType,
  mayContainTextureVariable,
  numberType,
  stringType,
  textureRefType,
  textureVariableType,
  typeFromAnnotation,
  unknownType,
  type RsglScope,
  type RsglType
} from "./types";

export {
  checkAssignable,
  resolveListSpreadElementType,
  validateResourceLocationLike,
  validateTextureRefExpressionSyntax
};

const expressionCheckHost: ContextualExpressionCheckHost = {
  checkExpression,
  checkExpressionForExpectedType,
  checkAssignable,
  checkContextualObjectExpression: (context, expression, scope, expectedType) =>
    checkObject(context, expression, scope, expectedType, { preserveInferredShape: true }),
  checkBlockstatePredicate,
  checkObjectExpression: (context, expression, scope, expectedType) =>
    checkObject(context, expression, scope, expectedType)
};

const blockstatePredicateCheckHost: BlockstatePredicateCheckHost = {
  checkExpression,
  checkCompileTimeCondition,
  resolveListSpreadElementType
};

export function checkBlockstatePredicate(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  return checkBlockstatePredicateWithHost(
    context,
    expression,
    scope,
    blockstatePredicateCheckHost
  );
}

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
      statePredicateMessages.compileTimeCondition,
      expression.range
    ));
  }
  return type;
}

function checkExpressionCore(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  if (expression.kind === "IdentifierExpr") {
    const symbol = lookup(scope, expression.name.text);
    context.references.push({ name: expression.name.text, range: expression.range, symbol });
    if (!symbol) {
      if (!context.isUndefinedSymbolDiagnosticSuppressed?.(expression.name.text)) {
        context.diagnostics.push(diagnostic(
          "rsgl.undefinedSymbol",
          `Undefined RSGL symbol '${expression.name.text}'.`,
          expression.range
        ));
      }
      return unknownType;
    }
    return symbol.type;
  }
  if (expression.kind === "TextureVariableLiteral") {
    return textureVariableType;
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
    return checkListExpression(context, expression, scope, expressionCheckHost);
  }
  if (expression.kind === "ObjectExpr") {
    return checkObject(context, expression, scope);
  }
  if (expression.kind === "CallExpr") {
    return checkCallExpression(context, expression, scope, expressionCheckHost);
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
    context.diagnostics.push(diagnostic(
      "rsgl.invalidForInExpression",
      "'name in iterable' generator expressions are only valid as seq arguments.",
      expression.range
    ));
    checkExpression(context, expression.iterable, scope);
    return unknownType;
  }
  if (expression.kind === "MemberExpr") {
    return checkMemberExpression(context, expression, scope, expressionCheckHost);
  }
  if (expression.kind === "IndexExpr") {
    return checkIndexExpression(context, expression, scope, expressionCheckHost);
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
    if (
      expression.operator === "+"
      && (mayContainTextureVariable(leftType) || mayContainTextureVariable(rightType))
    ) {
      return textureVariableType;
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
    let textureVariableInterpolation = false;
    for (const part of expression.parts) {
      if (part.kind === "expression") {
        textureVariableInterpolation ||= mayContainTextureVariable(
          checkExpression(context, part.expression, scope)
        );
      }
    }
    if (textureVariableInterpolation) {
      return textureVariableType;
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

export function checkResourceIdExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  return checkContextualResourceIdExpression(
    context,
    expression,
    scope,
    expressionCheckHost
  );
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
      resourceBodyMessages.useRequiresTemplateCallOrHelper,
      expression.range
    ));
    return type;
  }
  return checkCallExpression(context, expression, scope, expressionCheckHost, true);
}

export function checkExpressionForExpectedType(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  expectedType: RsglType
): RsglType {
  return checkContextualExpression(
    context,
    expression,
    scope,
    expectedType,
    expressionCheckHost
  );
}

export function checkTextureRefExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  return checkExpressionForExpectedType(context, expression, scope, textureRefType);
}

export function checkEquipmentLayerListExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): void {
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

export function checkEquipmentLayerNameExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): void {
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    return;
  }
  checkExpression(context, expression, scope);
}

export function checkStringEnumLikeExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): void {
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    return;
  }
  checkExpression(context, expression, scope);
}

export function checkLocalLetDecl(
  context: RsglExpressionCheckContext,
  statement: LetDeclNode,
  scope: RsglScope
): void {
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
  return checkObjectExpression(
    context,
    expression,
    scope,
    expressionCheckHost,
    expectedType,
    options
  );
}
