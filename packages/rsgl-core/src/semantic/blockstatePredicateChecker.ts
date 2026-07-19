import type {
  ExprNode,
  IndexExprNode,
  MemberExprNode,
  RsglNode
} from "../parser";
import {
  analyzeBlockstatePredicateExpression,
  MAX_BLOCKSTATE_PREDICATE_DEPTH,
  MAX_BLOCKSTATE_PREDICATE_NODES
} from "../blockstatePredicateComplexity";
import { diagnostic } from "./diagnostics";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { lookup } from "./scopes";
import { scopeForTruthyCondition } from "./typeNarrowing";
import {
  type RsglScope,
  type RsglType,
  statePredicateType,
  stringType,
  unknownType
} from "./types";

type StateAccess = MemberExprNode | IndexExprNode;

const predicateBinaryOperators = new Set(["&&", "||"]);
const comparisonOperators = new Set(["==", "!="]);
const membershipOperators = new Set(["in", "not in"]);

/** Ordinary-expression capabilities needed while checking predicate leaves. */
export interface BlockstatePredicateCheckHost {
  checkExpression(
    context: RsglExpressionCheckContext,
    expression: ExprNode,
    scope: RsglScope
  ): RsglType;
  checkCompileTimeCondition(
    context: RsglExpressionCheckContext,
    expression: ExprNode,
    scope: RsglScope
  ): RsglType;
  resolveListSpreadElementType(
    context: RsglExpressionCheckContext,
    spreadType: RsglType,
    spread: RsglNode
  ): RsglType | undefined;
}

/**
 * Checks the first-class StatePredicate language without making `$state` a
 * normal RSGL value. This routine is the only semantic entry point that
 * recognizes the runtime state namespace.
 */
export function checkBlockstatePredicateWithHost(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  host: BlockstatePredicateCheckHost
): RsglType {
  context.recordResolvedExpectedType?.(expression, statePredicateType);
  const complexity = analyzeBlockstatePredicateExpression(expression);
  if (!complexity.withinLimit) {
    context.diagnostics.push(diagnostic(
      "rsgl.blockstatePredicateTooComplex",
      complexity.nodes > MAX_BLOCKSTATE_PREDICATE_NODES
        ? `StatePredicate contains more than ${MAX_BLOCKSTATE_PREDICATE_NODES} expression nodes.`
        : `StatePredicate nesting exceeds the safe depth of ${MAX_BLOCKSTATE_PREDICATE_DEPTH}.`,
      expression.range
    ));
    recordType(context, expression, statePredicateType);
    return statePredicateType;
  }
  checkPredicateNode(context, expression, scope, host);
  recordType(context, expression, statePredicateType);
  return statePredicateType;
}

function checkPredicateNode(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  host: BlockstatePredicateCheckHost
): void {
  if (expression.kind === "ConditionalExpr") {
    host.checkCompileTimeCondition(context, expression.condition, scope);
    checkPredicateNode(
      context,
      expression.whenTrue,
      scopeForTruthyCondition(scope, expression.condition),
      host
    );
    checkPredicateNode(context, expression.whenFalse, scope, host);
    recordType(context, expression, statePredicateType);
    return;
  }

  if (checkStateAccess(context, expression, scope, host)) {
    recordType(context, expression, statePredicateType);
    return;
  }

  if (expression.kind === "IdentifierExpr") {
    const type = host.checkExpression(context, expression, scope);
    if (type.kind !== "StatePredicate" && type.kind !== "Any" && type.kind !== "Unknown") {
      invalidPredicate(
        context,
        expression,
        `Expected StatePredicate, got ${type.kind}.`
      );
    }
    return;
  }

  if (expression.kind !== "UnaryExpr" && expression.kind !== "BinaryExpr") {
    const type = host.checkExpression(context, expression, scope);
    if (!isPredicateValueType(type)) {
      invalidPredicate(
        context,
        expression,
        `Expected StatePredicate, got ${type.kind}.`
      );
    }
    return;
  }

  if (expression.kind === "UnaryExpr") {
    if (expression.operator !== "!") {
      invalidPredicate(context, expression, "StatePredicate only supports unary '!'.");
      host.checkExpression(context, expression.operand, scope);
      return;
    }
    checkPredicateNode(context, expression.operand, scope, host);
    recordType(context, expression, statePredicateType);
    return;
  }

  if (predicateBinaryOperators.has(expression.operator)) {
    checkPredicateNode(context, expression.left, scope, host);
    checkPredicateNode(context, expression.right, scope, host);
    recordType(context, expression, statePredicateType);
    return;
  }

  if (comparisonOperators.has(expression.operator)) {
    const access = checkStateAccess(context, expression.left, scope, host);
    if (!access) {
      host.checkExpression(context, expression.left, scope);
      invalidPredicate(
        context,
        expression.left,
        `The left side of '${expression.operator}' must be a $state property.`
      );
    }
    const rightAccess = checkStateAccess(context, expression.right, scope, host);
    if (rightAccess) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidBlockstatePredicateComparison",
        "StatePredicate comparisons require a compile-time scalar value on the right side.",
        expression.right.range
      ));
    } else {
      checkStateAtom(context, expression.right, scope, host, access?.propertyName);
    }
    recordType(context, expression, statePredicateType);
    return;
  }

  if (membershipOperators.has(expression.operator)) {
    const access = checkStateAccess(context, expression.left, scope, host);
    if (!access) {
      host.checkExpression(context, expression.left, scope);
      invalidPredicate(
        context,
        expression.left,
        `The left side of '${expression.operator}' must be a $state property.`
      );
    }
    checkMembershipValues(context, expression.right, scope, host, access?.propertyName);
    recordType(context, expression, statePredicateType);
    return;
  }

  host.checkExpression(context, expression.left, scope);
  host.checkExpression(context, expression.right, scope);
  invalidPredicate(
    context,
    expression,
    `Operator '${expression.operator}' is not valid in StatePredicate.`
  );
}

function checkStateAccess(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  host: BlockstatePredicateCheckHost
): { node: StateAccess; propertyName?: string } | undefined {
  if (
    expression.kind === "MemberExpr"
    && isStateNamespace(expression.object)
  ) {
    if (!/^[a-z0-9_]+$/.test(expression.property.text)) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidBlockstateStateProperty",
        `Blockstate state property '${expression.property.text}' must use lowercase letters, digits, or underscores.`,
        expression.property.range
      ));
    }
    recordType(context, expression.object, unknownType);
    recordType(context, expression, unknownType);
    return { node: expression, propertyName: expression.property.text };
  }

  if (
    expression.kind === "IndexExpr"
    && isStateNamespace(expression.object)
  ) {
    recordType(context, expression.object, unknownType);
    const keyType = checkStateAtom(context, expression.index, scope, host);
    if (!isPotentialStateScalar(keyType)) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidBlockstatePredicateProperty",
        "A computed $state property name must evaluate to a scalar string, number, or boolean.",
        expression.index.range
      ));
    }
    recordType(context, expression, unknownType);
    return { node: expression };
  }
  return undefined;
}

function isStateNamespace(expression: ExprNode): boolean {
  return expression.kind === "IdentifierExpr" && expression.name.text === "$state";
}

function checkMembershipValues(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  host: BlockstatePredicateCheckHost,
  propertyName?: string
): void {
  if (expression.kind === "ListExpr") {
    if (expression.elements.length === 0) {
      context.diagnostics.push(diagnostic(
        "rsgl.emptyBlockstatePredicateMembership",
        "StatePredicate membership requires at least one state value.",
        expression.range
      ));
    }
    for (const element of expression.elements) {
      if (element.kind !== "ListSpread") {
        checkStateAtom(context, element, scope, host, propertyName);
        continue;
      }
      const spreadType = host.checkExpression(context, element.expression, scope);
      const elementType = host.resolveListSpreadElementType(context, spreadType, element);
      if (elementType && !isPotentialStateScalar(elementType)) {
        context.diagnostics.push(diagnostic(
          "rsgl.invalidBlockstatePredicateValue",
          "StatePredicate membership lists may only contain scalar state values.",
          element.range
        ));
      }
    }
    return;
  }

  const type = host.checkExpression(context, expression, scope);
  const elementType = type.kind === "List" || type.kind === "Range"
    ? type.elementType ?? unknownType
    : undefined;
  if (!elementType) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidBlockstatePredicateMembership",
      "The right side of StatePredicate 'in' must be a List or Range.",
      expression.range
    ));
  } else if (!isPotentialStateScalar(elementType)) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidBlockstatePredicateValue",
      "StatePredicate membership values must be scalar strings, numbers, or booleans.",
      expression.range
    ));
  }
}

function checkStateAtom(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  host: BlockstatePredicateCheckHost,
  propertyName?: string
): RsglType {
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    recordType(context, expression, stringType);
    return stringType;
  }

  const symbol = expression.kind === "IdentifierExpr"
    ? lookup(scope, expression.name.text)
    : undefined;
  if (
    symbol?.node?.kind === "LetDecl"
    && propertyName
    && expression.kind === "IdentifierExpr"
    && expression.name.text !== propertyName
    && /^[a-z][a-z0-9_]*$/.test(expression.name.text)
  ) {
    context.diagnostics.push(diagnostic(
      "rsgl.blockstateEnumLiteralShadowed",
      `Local '${expression.name.text}' shadows a bare blockstate enum literal with the same spelling; rename it or make the intended value explicit.`,
      expression.range,
      "warning"
    ));
  }

  const type = host.checkExpression(context, expression, scope);
  if (!isPotentialStateScalar(type)) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidBlockstatePredicateValue",
      "StatePredicate values must be scalar strings, numbers, or booleans.",
      expression.range
    ));
  }
  return type;
}

function isPotentialStateScalar(type: RsglType): boolean {
  if (type.kind === "Union") {
    return (type.options ?? []).every(isPotentialStateScalar);
  }
  return type.kind === "String"
    || type.kind === "Number"
    || type.kind === "Boolean"
    || type.kind === "Path"
    || type.kind === "ResourceId"
    || type.kind === "ModelId"
    || type.kind === "TextureId"
    || type.kind === "Any"
    || type.kind === "Unknown"
    || type.kind === "Json";
}

function invalidPredicate(
  context: RsglExpressionCheckContext,
  node: RsglNode,
  message: string
): void {
  context.diagnostics.push(diagnostic(
    "rsgl.invalidBlockstatePredicate",
    message,
    node.range
  ));
}

function isPredicateValueType(type: RsglType): boolean {
  if (type.kind === "Union") {
    return (type.options ?? []).every(isPredicateValueType);
  }
  return type.kind === "StatePredicate" || type.kind === "Any" || type.kind === "Unknown";
}

function recordType(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  type: RsglType
): void {
  context.recordResolvedExpressionType?.(expression, type);
}
