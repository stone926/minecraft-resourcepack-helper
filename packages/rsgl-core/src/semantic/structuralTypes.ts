import { uniqueValues } from "../../../mc-assets/src";
import type { ExprNode } from "../parser";
import { isAssignable } from "./typeRelations";
import { combineRsglTypes, type RsglUnionBudgetOptions } from "./typeNormalization";
import {
  anyType,
  hasLiteralValue,
  missingType,
  numberType,
  RsglObjectProperty,
  RsglType,
  unknownType
} from "./types";

export type StructuralAccessIssue =
  | {
      kind: "invalidMemberTarget";
      actualType: RsglType;
      property: string;
    }
  | {
      kind: "unknownProperty";
      actualType: RsglType;
      property: string;
      suggestion?: string;
    }
  | {
      kind: "invalidIndexTarget";
      actualType: RsglType;
    }
  | {
      kind: "invalidIndexType";
      targetKind: "List" | "Range" | "Object";
      actualType: RsglType;
    }
  | {
      kind: "dynamicKeyMayBeMissing";
      actualType: RsglType;
    };

export interface StructuralTypeResult {
  type: RsglType;
  issues: StructuralAccessIssue[];
}

export type StructuralIterationIssue =
  | {
      kind: "notIterable";
      actualType: RsglType;
    }
  | {
      kind: "invalidDestructuring";
      actualType: RsglType;
      bindingCount: number;
    }
  | {
      kind: "unknownDestructuringProperty";
      actualType: RsglType;
      property: string;
      bindingIndex: number;
      suggestion?: string;
    }
  | {
      kind: "optionalDestructuringProperty";
      actualType: RsglType;
      property: string;
      bindingIndex: number;
    };

export interface LoopBindingTypeResult {
  bindingTypes: RsglType[];
  issues: StructuralIterationIssue[];
}

/** Describes how one for-loop dimension selects values from each iterable item. */
export type LoopBindingSelection =
  | { kind: "value" }
  | { kind: "properties"; properties: readonly string[] };

export function resolveMemberType(
  type: RsglType,
  property: string,
  budgetOptions?: RsglUnionBudgetOptions
): StructuralTypeResult {
  if (type.kind === "Union") {
    return combineStructuralResults(
      (type.options ?? []).map(option => resolveMemberType(option, property, budgetOptions)),
      budgetOptions
    );
  }
  if (type.kind === "Any" || type.kind === "Json") {
    return { type: anyType, issues: [] };
  }
  if (type.kind === "Unknown") {
    return { type: unknownType, issues: [] };
  }
  if (type.kind !== "Object") {
    return {
      type: unknownType,
      issues: [{ kind: "invalidMemberTarget", actualType: type, property }]
    };
  }

  const propertyMetadata = type.properties?.get(property);
  if (propertyMetadata) {
    return { type: accessedPropertyType(propertyMetadata), issues: [] };
  }
  if (type.indexType) {
    return { type: type.indexType, issues: [] };
  }
  if (type.open) {
    return { type: anyType, issues: [] };
  }
  return {
    type: unknownType,
    issues: [{
      kind: "unknownProperty",
      actualType: type,
      property,
      suggestion: closestPropertyName(property, type.properties?.keys() ?? [])
    }]
  };
}

export function resolveIndexType(
  targetType: RsglType,
  indexType: RsglType,
  staticKey?: string,
  budgetOptions?: RsglUnionBudgetOptions
): StructuralTypeResult {
  if (targetType.kind === "Union") {
    return combineStructuralResults(
      (targetType.options ?? []).map(option =>
        resolveIndexType(option, indexType, staticKey, budgetOptions)
      ),
      budgetOptions
    );
  }
  if (targetType.kind === "Any" || targetType.kind === "Json") {
    return { type: anyType, issues: [] };
  }
  if (targetType.kind === "Unknown") {
    return { type: unknownType, issues: [] };
  }
  if (targetType.kind === "List" || targetType.kind === "Range") {
    const issues: StructuralAccessIssue[] = isAssignable(numberType, indexType)
      ? []
      : [{ kind: "invalidIndexType", targetKind: targetType.kind, actualType: indexType }];
    return {
      type: targetType.elementType ?? unknownType,
      issues
    };
  }
  if (targetType.kind !== "Object") {
    return {
      type: unknownType,
      issues: [{ kind: "invalidIndexTarget", actualType: targetType }]
    };
  }

  const issues: StructuralAccessIssue[] = isObjectKeyType(indexType)
    ? []
    : [{ kind: "invalidIndexType", targetKind: "Object", actualType: indexType }];
  if (staticKey !== undefined) {
    const propertyMetadata = targetType.properties?.get(staticKey);
    if (propertyMetadata) {
      return { type: accessedPropertyType(propertyMetadata), issues };
    }
    if (targetType.indexType) {
      return { type: targetType.indexType, issues };
    }
    if (targetType.open) {
      return { type: anyType, issues };
    }
    return {
      type: unknownType,
      issues: [
        ...issues,
        {
          kind: "unknownProperty",
          actualType: targetType,
          property: staticKey,
          suggestion: closestPropertyName(staticKey, targetType.properties?.keys() ?? [])
        }
      ]
    };
  }

  const finiteKeys = finiteObjectKeysFromType(indexType);
  if (finiteKeys && finiteKeys.length > 0) {
    return combineStructuralResults(
      finiteKeys.map(key => resolveIndexType(targetType, indexType, key, budgetOptions)),
      budgetOptions
    );
  }

  if (targetType.indexType) {
    return { type: targetType.indexType, issues };
  }
  if (targetType.open) {
    return { type: anyType, issues };
  }

  const possibleTypes = Array.from(targetType.properties?.values() ?? [])
    .map(accessedPropertyType);
  return {
    type: combineRsglTypes([
      ...(possibleTypes.length > 0 ? possibleTypes : []),
      missingType
    ], false, budgetOptions),
    issues: [
      ...issues,
      ...(issues.length === 0
        ? [{ kind: "dynamicKeyMayBeMissing", actualType: targetType } as const]
        : [])
    ]
  };
}

export function resolveLoopBindingTypes(
  iterableType: RsglType,
  selection: LoopBindingSelection,
  budgetOptions?: RsglUnionBudgetOptions
): LoopBindingTypeResult {
  const bindingCount = loopBindingSelectionCount(selection);
  if (bindingCount <= 0) {
    return { bindingTypes: [], issues: [] };
  }
  if (iterableType.kind === "Union") {
    const results = (iterableType.options ?? [])
      .map(option => resolveLoopBindingTypes(option, selection, budgetOptions));
    return {
      bindingTypes: Array.from({ length: bindingCount }, (_, index) =>
        combineRsglTypes(
          results.map(result => result.bindingTypes[index] ?? unknownType),
          false,
          budgetOptions
        )
      ),
      issues: deduplicateIterationIssues(
        results.flatMap(result => result.issues),
        budgetOptions
      )
    };
  }
  if (iterableType.kind === "Any" || iterableType.kind === "Json" || iterableType.kind === "Unknown") {
    return {
      bindingTypes: Array.from({ length: bindingCount }, () =>
        iterableType.kind === "Unknown" ? unknownType : anyType
      ),
      issues: []
    };
  }
  if (iterableType.kind === "Range") {
    if (selection.kind === "value") {
      return {
        bindingTypes: [iterableType.elementType ?? numberType],
        issues: []
      };
    }
    return invalidDestructuringResult(iterableType, bindingCount);
  }
  if (iterableType.kind !== "List") {
    return {
      bindingTypes: Array.from({ length: bindingCount }, () => unknownType),
      issues: [{ kind: "notIterable", actualType: iterableType }]
    };
  }

  const elementType = iterableType.elementType ?? unknownType;
  if (selection.kind === "value") {
    return { bindingTypes: [elementType], issues: [] };
  }
  return resolveNamedObjectBindings(elementType, selection.properties, budgetOptions);
}

export function staticIndexKey(expression: ExprNode): string | undefined {
  switch (expression.kind) {
    case "StringLiteral":
    case "ResourceLocationExpr":
      return expression.value;
    case "NumberLiteral":
      return String(expression.value);
    case "BooleanLiteral":
      return String(expression.value);
    case "NullLiteral":
      return "null";
    default:
      return undefined;
  }
}

function resolveNamedObjectBindings(
  elementType: RsglType,
  properties: readonly string[],
  budgetOptions?: RsglUnionBudgetOptions
): LoopBindingTypeResult {
  const results = properties.map(property =>
    resolveMemberType(elementType, property, budgetOptions)
  );
  const issues: StructuralIterationIssue[] = [];
  let invalidTarget = false;
  for (const [bindingIndex, result] of results.entries()) {
    for (const issue of result.issues) {
      if (issue.kind === "unknownProperty") {
        issues.push({
          kind: "unknownDestructuringProperty",
          actualType: issue.actualType,
          property: issue.property,
          bindingIndex,
          ...(issue.suggestion ? { suggestion: issue.suggestion } : {})
        });
      } else if (issue.kind === "invalidMemberTarget") {
        invalidTarget = true;
      }
    }
    if (typeMayBeMissing(result.type)) {
      issues.push({
        kind: "optionalDestructuringProperty",
        actualType: result.type,
        property: properties[bindingIndex],
        bindingIndex
      });
    }
  }
  if (invalidTarget) {
    issues.push({
      kind: "invalidDestructuring",
      actualType: elementType,
      bindingCount: properties.length
    });
  }
  return {
    bindingTypes: results.map(result => result.type),
    issues: deduplicateIterationIssues(issues, budgetOptions)
  };
}

function invalidDestructuringResult(
  actualType: RsglType,
  bindingCount: number
): LoopBindingTypeResult {
  return {
    bindingTypes: Array.from({ length: bindingCount }, () => unknownType),
    issues: [{ kind: "invalidDestructuring", actualType, bindingCount }]
  };
}

function combineStructuralResults(
  results: readonly StructuralTypeResult[],
  budgetOptions?: RsglUnionBudgetOptions
): StructuralTypeResult {
  return {
    type: combineRsglTypes(results.map(result => result.type), false, budgetOptions),
    issues: deduplicateAccessIssues(results.flatMap(result => result.issues))
  };
}

function isObjectKeyType(type: RsglType): boolean {
  if (type.kind === "Union") {
    return (type.options ?? []).every(isObjectKeyType);
  }
  return type.kind === "String"
    || type.kind === "Number"
    || type.kind === "Boolean"
    || type.kind === "Null"
    || type.kind === "Path"
    || type.kind === "ResourceId"
    || type.kind === "ModelId"
    || type.kind === "TextureId"
    || type.kind === "Any"
    || type.kind === "Unknown"
    || type.kind === "Json";
}

function deduplicateAccessIssues(issues: readonly StructuralAccessIssue[]): StructuralAccessIssue[] {
  return Array.from(new Map(issues.map(issue => [JSON.stringify(issue), issue])).values());
}

function deduplicateIterationIssues(
  issues: readonly StructuralIterationIssue[],
  budgetOptions?: RsglUnionBudgetOptions
): StructuralIterationIssue[] {
  const byKey = new Map<string, StructuralIterationIssue>();
  for (const issue of issues) {
    const key = iterationIssueKey(issue);
    const existing = byKey.get(key);
    if (existing?.kind === "invalidDestructuring" && issue.kind === "invalidDestructuring") {
      byKey.set(key, {
        kind: "invalidDestructuring",
        actualType: combineRsglTypes(
          [existing.actualType, issue.actualType],
          false,
          budgetOptions
        ),
        bindingCount: issue.bindingCount
      });
      continue;
    }
    if (!existing) {
      byKey.set(key, issue);
    }
  }
  return Array.from(byKey.values());
}

function iterationIssueKey(issue: StructuralIterationIssue): string {
  if (issue.kind === "invalidDestructuring") {
    return `${issue.kind}:${issue.bindingCount}`;
  }
  if (issue.kind === "unknownDestructuringProperty") {
    return `${issue.kind}:${issue.property}:${issue.bindingIndex}`;
  }
  if (issue.kind === "optionalDestructuringProperty") {
    return `${issue.kind}:${issue.property}:${issue.bindingIndex}`;
  }
  return `${issue.kind}:${issue.actualType.kind}`;
}

function typeMayBeMissing(type: RsglType): boolean {
  return type.kind === "Missing"
    || (type.kind === "Union" && (type.options ?? []).some(option => option.kind === "Missing"));
}

function loopBindingSelectionCount(selection: LoopBindingSelection): number {
  return selection.kind === "value" ? 1 : selection.properties.length;
}

function closestPropertyName(name: string, candidates: Iterable<string>): string | undefined {
  let closest: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (!closest || distance < closest.distance || (distance === closest.distance && candidate < closest.name)) {
      closest = { name: candidate, distance };
    }
  }
  if (!closest) {
    return undefined;
  }
  const maximumLength = Math.max(name.length, closest.name.length);
  const maximumDistance = maximumLength > 3
    ? Math.max(2, Math.floor(maximumLength / 3))
    : 1;
  return closest.distance <= maximumDistance ? closest.name : undefined;
}

function accessedPropertyType(property: RsglObjectProperty): RsglType {
  return property.optional
    ? combineRsglTypes([property.type, missingType])
    : property.type;
}

export function finiteObjectKeysFromType(type: RsglType): string[] | undefined {
  const options = type.kind === "Union" ? type.options ?? [] : [type];
  const keys: string[] = [];
  for (const option of options) {
    if (!hasLiteralValue(option)) {
      return undefined;
    }
    keys.push(String(option.literalValue));
  }
  return uniqueValues(keys);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
    }
    previous = current;
  }
  return previous[right.length];
}
