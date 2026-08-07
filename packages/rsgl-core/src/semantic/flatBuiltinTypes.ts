import { uniqueValues } from "../../../mc-assets/src";
import type { ExprNode } from "../parser";
import { normalizeFlatDepth } from "../flatDepth";
import {
  combineRsglTypes,
  type RsglUnionBudgetOptions
} from "./typeNormalization";
import { isAssignable } from "./typeRelations";
import {
  numberType,
  stringType,
  unknownType,
  type RsglType
} from "./types";

const maxContextualFlatDepth = 32;

/**
 * Contextually types fully literal nested Lists when the requested depth is
 * guaranteed to expose their leaves. Dynamic collection-valued expressions
 * keep their declared type instead of being forced into a guessed shape.
 */
export function contextualFlatSourceType(
  expectedElement: RsglType,
  depths: readonly number[] | undefined,
  expression: ExprNode
): RsglType | undefined {
  if (!depths || depths.length === 0) {
    return undefined;
  }
  const sourceNesting = staticFlatSourceNesting(expression, maxContextualFlatDepth);
  if (sourceNesting === undefined || sourceNesting < 1) {
    return undefined;
  }
  const nestedDepth = sourceNesting - 1;
  if (depths.some(depth => depth < nestedDepth)) {
    return undefined;
  }

  let inputElement = expectedElement;
  for (let level = 0; level < nestedDepth; level += 1) {
    const options: RsglType[] = [expectedElement, listOf(inputElement)];
    if (isAssignable(expectedElement, numberType)) {
      options.push({ kind: "Range", elementType: numberType });
    }
    inputElement = combineRsglTypes(options);
  }
  return listOf(inputElement);
}

/**
 * Returns every statically known normalized depth, or undefined when runtime
 * data decides the depth. Negative values and NaN behave like depth zero.
 */
export function staticFlatDepths(
  type: RsglType,
  expression: ExprNode
): number[] | undefined {
  if (
    expression.kind === "UnaryExpr"
    && expression.operator === "-"
    && expression.operand.kind === "NumberLiteral"
  ) {
    return [normalizeFlatDepth(-expression.operand.value)];
  }

  const values: number[] = [];
  const append = (candidate: RsglType): boolean => {
    if (candidate.kind === "Union") {
      return (candidate.options ?? []).every(append);
    }
    if (candidate.kind !== "Number" || typeof candidate.literalValue !== "number") {
      return false;
    }
    values.push(normalizeFlatDepth(candidate.literalValue));
    return true;
  };
  if (!append(type)) {
    return undefined;
  }
  return uniqueValues(values);
}

/**
 * Known depths produce an exact element type. A runtime depth conservatively
 * includes the element shape possible at every nesting level.
 */
export function inferFlatElementType(
  sourceElement: RsglType,
  depths: readonly number[] | undefined,
  budgetOptions: RsglUnionBudgetOptions,
  expectedElement?: RsglType
): RsglType {
  const candidates: RsglType[] = [];
  if (depths) {
    for (const depth of depths) {
      collectKnownFlatTypes(sourceElement, depth, candidates, new Set());
    }
  } else {
    collectVariableFlatTypes(sourceElement, candidates, new Set());
  }
  const inferred = combineRsglTypes(candidates, false, budgetOptions);
  return expectedElement && acceptsContextualFlatResult(expectedElement, inferred)
    ? expectedElement
    : inferred;
}

function staticFlatSourceNesting(
  expression: ExprNode,
  remainingDepth: number
): number | undefined {
  if (remainingDepth < 0) {
    return undefined;
  }
  if (expression.kind === "ListExpr") {
    let nesting = 1;
    for (const element of expression.elements) {
      if (element.kind === "ListSpread") {
        return undefined;
      }
      const elementNesting = staticFlatSourceNesting(element, remainingDepth - 1);
      if (elementNesting === undefined) {
        return undefined;
      }
      nesting = Math.max(nesting, 1 + elementNesting);
    }
    return nesting;
  }
  if (expression.kind === "RangeExpr") {
    return 1;
  }
  if (expression.kind === "ConditionalExpr") {
    const whenTrue = staticFlatSourceNesting(expression.whenTrue, remainingDepth);
    const whenFalse = staticFlatSourceNesting(expression.whenFalse, remainingDepth);
    return whenTrue === undefined || whenFalse === undefined
      ? undefined
      : Math.max(whenTrue, whenFalse);
  }
  if (
    expression.kind === "IdentifierExpr"
    || expression.kind === "CallExpr"
    || expression.kind === "MemberExpr"
    || expression.kind === "IndexExpr"
    || expression.kind === "MatchExpr"
    || expression.kind === "ForInExpr"
    || expression.kind === "MissingExpr"
  ) {
    return undefined;
  }
  return 0;
}

function collectKnownFlatTypes(
  type: RsglType,
  depth: number,
  candidates: RsglType[],
  active: Set<RsglType>
): void {
  if (type.kind === "Union") {
    for (const option of type.options ?? []) {
      collectKnownFlatTypes(option, depth, candidates, active);
    }
    return;
  }
  if (depth <= 0 || (type.kind !== "List" && type.kind !== "Range")) {
    candidates.push(type);
    return;
  }
  if (active.has(type)) {
    candidates.push(unknownType);
    return;
  }
  active.add(type);
  collectKnownFlatTypes(
    type.elementType ?? (type.kind === "Range" ? numberType : unknownType),
    depth === Number.POSITIVE_INFINITY ? depth : depth - 1,
    candidates,
    active
  );
  active.delete(type);
}

function collectVariableFlatTypes(
  type: RsglType,
  candidates: RsglType[],
  active: Set<RsglType>
): void {
  if (type.kind === "Union") {
    for (const option of type.options ?? []) {
      collectVariableFlatTypes(option, candidates, active);
    }
    return;
  }
  candidates.push(type);
  if (type.kind !== "List" && type.kind !== "Range") {
    return;
  }
  if (active.has(type)) {
    candidates.push(unknownType);
    return;
  }
  active.add(type);
  collectVariableFlatTypes(
    type.elementType ?? (type.kind === "Range" ? numberType : unknownType),
    candidates,
    active
  );
  active.delete(type);
}

function acceptsContextualFlatResult(expected: RsglType, actual: RsglType): boolean {
  if (actual.kind === "Union") {
    return (actual.options?.length ?? 0) > 0
      && (actual.options ?? []).every(option => acceptsContextualFlatResult(expected, option));
  }
  if (isAssignable(expected, actual)) {
    return true;
  }
  return isContextualResourceType(expected) && isAssignable(stringType, actual);
}

function isContextualResourceType(type: RsglType): boolean {
  return type.kind === "ResourceId"
    || type.kind === "ModelId"
    || type.kind === "TextureId"
    || type.kind === "TextureRef"
    || type.kind === "TextureVariable";
}

function listOf(elementType: RsglType): RsglType {
  return { kind: "List", elementType };
}
