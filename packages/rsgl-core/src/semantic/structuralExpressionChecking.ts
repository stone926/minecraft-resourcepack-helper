import type {
  ExprNode,
  ListExprNode,
  ObjectExprNode,
  RsglNode
} from "../parser";
import {
  checkContextualObject,
  type ContextualObjectCheckHost,
  type ContextualObjectCheckOptions
} from "./contextualObjectChecking";
import { diagnostic } from "./diagnostics";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { resolveListSpreadElementType } from "./listSpreadTypes";
import { checkModuleNamespaceMember } from "./moduleNamespace";
import {
  resolveIndexType,
  resolveMemberType,
  staticIndexKey,
  type StructuralAccessIssue
} from "./structuralTypes";
import { inferListType } from "./typeNormalization";
import { formatType } from "./typeRelations";
import { inferredUnionBudgetOptions } from "./unionBudget";
import { unknownType, type RsglScope, type RsglType } from "./types";

export type StructuralExpressionCheckHost = ContextualObjectCheckHost;

export function checkMemberExpression(
  context: RsglExpressionCheckContext,
  expression: Extract<ExprNode, { kind: "MemberExpr" }>,
  scope: RsglScope,
  host: StructuralExpressionCheckHost
): RsglType {
  const objectType = host.checkExpression(context, expression.object, scope);
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

export function checkIndexExpression(
  context: RsglExpressionCheckContext,
  expression: Extract<ExprNode, { kind: "IndexExpr" }>,
  scope: RsglScope,
  host: StructuralExpressionCheckHost
): RsglType {
  const objectType = host.checkExpression(context, expression.object, scope);
  const indexType = host.checkExpression(context, expression.index, scope);
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

export function checkObjectExpression(
  context: RsglExpressionCheckContext,
  expression: ObjectExprNode,
  scope: RsglScope,
  host: StructuralExpressionCheckHost,
  expectedType?: RsglType,
  options?: ContextualObjectCheckOptions
): RsglType {
  return checkContextualObject(
    context,
    expression,
    scope,
    host,
    expectedType,
    options
  );
}

export function checkListExpression(
  context: RsglExpressionCheckContext,
  expression: ListExprNode,
  scope: RsglScope,
  host: StructuralExpressionCheckHost
): RsglType {
  const elementTypes: RsglType[] = [];
  for (const element of expression.elements) {
    if (element.kind !== "ListSpread") {
      elementTypes.push(host.checkExpression(context, element, scope));
      continue;
    }
    const spreadType = host.checkExpression(context, element.expression, scope);
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
