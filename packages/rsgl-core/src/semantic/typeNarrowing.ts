import type { ExprNode } from "../parser";
import { finiteStringDomainFromType } from "./domainChecks";
import { combineRsglTypes } from "./typeNormalization";
import { createChildScope, lookup } from "./scopes";
import type { RsglObjectProperty, RsglScope, RsglType } from "./types";

/**
 * Creates a true-branch scope for explicit presence checks. A true conjunction
 * carries the facts proven by both operands; no other truthiness
 * expression narrows an optional field because present values may be falsy.
 */
export function scopeForTruthyCondition(scope: RsglScope, condition: ExprNode): RsglScope {
  if (condition.kind === "BinaryExpr" && condition.operator === "&&") {
    const leftScope = scopeForTruthyCondition(scope, condition.left);
    return scopeForTruthyCondition(leftScope, condition.right);
  }
  const target = hasConditionTarget(condition, scope);
  if (!target) {
    return scope;
  }
  const symbol = lookup(scope, target.objectName);
  if (!symbol) {
    return scope;
  }
  const narrowedType = narrowPresentFields(symbol.type, target.fieldNames);
  if (narrowedType === symbol.type) {
    return scope;
  }
  const branchScope = createChildScope(scope, "block");
  branchScope.symbols.set(symbol.name, { ...symbol, type: narrowedType });
  return branchScope;
}

function hasConditionTarget(
  condition: ExprNode,
  scope: RsglScope
): { objectName: string; fieldNames: string[] } | undefined {
  if (
    condition.kind !== "CallExpr"
    || condition.callee.kind !== "IdentifierExpr"
    || condition.callee.name.text !== "has"
    || lookup(scope, condition.callee.name.text)?.kind !== "builtin"
  ) {
    return undefined;
  }
  const positional = condition.args.filter(argument => !argument.name);
  const objectArgument = condition.args.find(argument => argument.name?.text === "object") ?? positional[0];
  const keyArgument = condition.args.find(argument => argument.name?.text === "key") ?? positional[1];
  if (objectArgument?.value.kind !== "IdentifierExpr" || !keyArgument) {
    return undefined;
  }
  const fieldNames = finiteHasKeyDomain(keyArgument.value, scope);
  if (!fieldNames?.length) {
    return undefined;
  }
  return {
    objectName: objectArgument.value.name.text,
    fieldNames
  };
}

function finiteHasKeyDomain(expression: ExprNode, scope: RsglScope): string[] | null {
  if (expression.kind === "StringLiteral") {
    return [expression.value];
  }
  if (expression.kind !== "IdentifierExpr") {
    return null;
  }
  return finiteStringDomainFromType(lookup(scope, expression.name.text)?.type);
}

function narrowPresentFields(type: RsglType, fieldNames: readonly string[]): RsglType {
  const variants = fieldNames
    .map(fieldName => narrowPresentField(type, fieldName))
    .filter(option => option.kind !== "Missing");
  return variants.length > 0 ? combineRsglTypes(variants) : type;
}

function narrowPresentField(type: RsglType, fieldName: string): RsglType {
  if (type.kind === "Union") {
    const narrowed = (type.options ?? [])
      .map(option => narrowPresentField(option, fieldName))
      .filter(option => option.kind !== "Missing");
    return narrowed.length > 0 ? combineRsglTypes(narrowed) : type;
  }
  if (type.kind === "Any" || type.kind === "Json" || type.kind === "Unknown") {
    return type;
  }
  if (type.kind !== "Object") {
    // `has` is false for every statically known non-object runtime value. Drop
    // those union arms from the true branch while retaining dynamic types above,
    // whose runtime shape cannot be decided statically.
    return { kind: "Missing" };
  }
  const property = type.properties?.get(fieldName);
  if (!property) {
    return type.open ? type : { kind: "Missing" };
  }
  if (!property.optional) {
    return type;
  }
  const properties = new Map(type.properties);
  properties.set(fieldName, requiredProperty(property));
  return { ...type, properties };
}

function requiredProperty(property: RsglObjectProperty): RsglObjectProperty {
  return { ...property, optional: false };
}
