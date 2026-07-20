import { uniqueValues } from "../../../mc-assets/src";
import {
  ExprNode,
  ObjectExprNode,
  ObjectPropertyNode,
  RsglDiagnostic,
  RsglNode,
  TextRange
} from "../parser";
import { diagnostic } from "./diagnostics";
import {
  mergeObjectTypeAlternatives,
  optionalObjectProjection
} from "./collectionRecordTypes";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { lookup } from "./scopes";
import { objectSpreadTypes } from "./objectSpreadTypes";
import { finiteObjectKeysFromType, staticIndexKey } from "./structuralTypes";
import { combineRsglTypes, rsglTypeKey } from "./typeNormalization";
import { isAssignable } from "./typeRelations";
import { inferredUnionBudgetOptions } from "./unionBudget";
import {
  hasLiteralValue,
  inferLiteralType,
  objectProperty,
  RsglScope,
  RsglType,
  unknownType
} from "./types";

export interface ContextualObjectArm {
  type: RsglType;
  ambiguous: boolean;
}

interface ContextualObjectArmScore {
  type: RsglType;
  mismatches: number;
  missing: number;
  excess: number;
  literalMatches: number;
}

interface DiagnosticSink {
  readonly diagnostics: RsglDiagnostic[];
}

export interface ContextualObjectCheckHost {
  checkExpression(
    context: RsglExpressionCheckContext,
    expression: ExprNode,
    scope: RsglScope
  ): RsglType;
  checkExpressionForExpectedType(
    context: RsglExpressionCheckContext,
    expression: ExprNode,
    scope: RsglScope,
    expectedType: RsglType
  ): RsglType;
  checkAssignable(
    context: RsglExpressionCheckContext,
    expected: RsglType,
    actual: RsglType,
    node: RsglNode
  ): void;
}

export interface ContextualObjectCheckOptions {
  /** Retain actual provided fields while still applying expected field types. */
  preserveInferredShape?: boolean;
}

export function checkContextualObject(
  context: RsglExpressionCheckContext,
  expression: ObjectExprNode,
  scope: RsglScope,
  host: ContextualObjectCheckHost,
  expectedType?: RsglType,
  options: ContextualObjectCheckOptions = {}
): RsglType {
  const providedNames = new Set<string>();
  let inferredAlternatives: RsglType[] = [{
    kind: "Object",
    properties: new Map(),
    open: false
  }];
  for (const property of expression.properties) {
    if (property.kind === "ObjectSpread") {
      const expectedProjection = expectedType ? optionalObjectProjection(expectedType) : undefined;
      const diagnosticStart = context.diagnostics.length;
      const checkedType = expectedProjection
        ? host.checkExpressionForExpectedType(
          context,
          property.expression,
          scope,
          expectedProjection
        )
        : host.checkExpression(context, property.expression, scope);
      const shapeType = spreadSourceShape(property.expression, checkedType, scope);
      const spreadTypes = objectSpreadTypes(context, shapeType, property);
      if (!spreadTypes) {
        continue;
      }
      if (
        expectedProjection
        && !isDynamicObjectType(shapeType)
        && context.diagnostics.length === diagnosticStart
      ) {
        host.checkAssignable(context, expectedProjection, shapeType, property.expression);
      }
      addGuaranteedSpreadNames(providedNames, property.expression, spreadTypes);
      reportSpreadExcessFields(context, expectedType, spreadTypes, property.range);
      inferredAlternatives = mergeObjectTypeAlternatives({
        context,
        range: expression.range
      }, inferredAlternatives, spreadTypes);
      continue;
    }
    const key = objectKeyName(property);
    const expectedProperty = key ? expectedType?.properties?.get(key) : undefined;
    let computedKeys: string[] | undefined;
    if (property.key.kind === "DynamicKey") {
      const keyType = host.checkExpression(context, property.key.expression, scope);
      const staticKey = staticIndexKey(property.key.expression);
      computedKeys = staticKey !== undefined
        ? [staticKey]
        : finiteObjectKeysFromType(keyType);
    }
    const expectedValueType = expectedProperty?.type
      ?? (key ? expectedType?.indexType : expectedComputedValueType(expectedType, computedKeys));
    const diagnosticStart = context.diagnostics.length;
    const valueType = expectedValueType
      ? host.checkExpressionForExpectedType(context, property.value, scope, expectedValueType)
      : host.checkExpression(context, property.value, scope);
    if (expectedValueType && context.diagnostics.length === diagnosticStart) {
      host.checkAssignable(context, expectedValueType, valueType, property.value);
    }
    if (key) {
      providedNames.add(key);
      if (expectedType && !expectedProperty && !expectedType.open && !expectedType.indexType) {
        reportExcessRecordField(context, expectedType, key, property.key.range);
      }
      inferredAlternatives = mergeObjectTypeAlternatives({
        context,
        range: expression.range
      }, inferredAlternatives, [{
        kind: "Object",
        properties: new Map([[key, objectProperty(valueType, false, property.key.range)]]),
        open: false
      }]);
    }
    if (property.key.kind === "DynamicKey") {
      if (expectedType && !expectedType.open && !expectedType.indexType) {
        if (!computedKeys?.length) {
          context.diagnostics.push(diagnostic(
            "rsgl.dynamicRecordKeyRequiresFiniteDomain",
            "A computed key in a closed record must have a finite literal type; use a declared field or annotate the value as Json.",
            property.key.expression.range
          ));
        } else {
          for (const computedKey of computedKeys) {
            if (!expectedType.properties?.has(computedKey)) {
              reportExcessRecordField(
                context,
                expectedType,
                computedKey,
                property.key.expression.range,
                true
              );
            }
          }
        }
      }
      if (
        computedKeys?.length === 1
        && expectedType?.properties?.has(computedKeys[0])
      ) {
        providedNames.add(computedKeys[0]);
      }
      inferredAlternatives = mergeObjectTypeAlternatives({
        context,
        range: expression.range
      }, inferredAlternatives, [{
        kind: "Object",
        properties: new Map(),
        indexType: valueType,
        open: true
      }]);
    }
  }
  if (expectedType) {
    for (const [name, property] of expectedType.properties ?? []) {
      if (!property.optional && !providedNames.has(name)) {
        context.diagnostics.push(diagnostic(
          "rsgl.missingRecordField",
          `Record literal is missing required field '${name}'.`,
          expression.range
        ));
      }
    }
    if (!options.preserveInferredShape) {
      return expectedType;
    }
  }
  return combineRsglTypes(
    inferredAlternatives,
    false,
    inferredUnionBudgetOptions(context.diagnostics, expression.range)
  );
}

export function objectKeyName(property: ObjectPropertyNode): string | null {
  if (property.key.kind === "Identifier") {
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  if (property.key.kind === "NumberLiteral") {
    return property.key.raw;
  }
  return null;
}

export function selectContextualObjectArm(
  expression: ObjectExprNode,
  expectedType: RsglType,
  scope: RsglScope
): ContextualObjectArm | undefined {
  if (expectedType.kind === "Object") {
    return { type: expectedType, ambiguous: false };
  }
  if (expectedType.kind !== "Union") {
    return undefined;
  }
  const arms = (expectedType.options ?? []).filter(option => option.kind === "Object");
  if (arms.length === 0) {
    return undefined;
  }
  if (arms.length === 1) {
    return { type: arms[0], ambiguous: false };
  }

  const scores = arms.map(type => scoreContextualObjectArm(expression, type, scope));
  scores.sort(compareContextualObjectArmScores);
  const best = scores.filter(score => compareContextualObjectArmScores(score, scores[0]) === 0);
  const perfect = best[0].mismatches === 0 && best[0].missing === 0 && best[0].excess === 0;
  const safelyEquivalent = perfect && contextualExpectationsEquivalent(expression, best, scope);
  return {
    type: best[0].type,
    ambiguous: best.length > 1 && !safelyEquivalent
  };
}

export function expectedComputedValueType(
  expectedType: RsglType | undefined,
  computedKeys: readonly string[] | undefined
): RsglType | undefined {
  if (!expectedType) {
    return undefined;
  }
  if (!computedKeys?.length) {
    return expectedType.indexType;
  }
  const types: RsglType[] = [];
  for (const key of computedKeys) {
    const expected = expectedObjectValueType(expectedType, key);
    if (!expected) {
      return undefined;
    }
    types.push(expected);
  }
  return combineRsglTypes(types);
}

export function reportExcessRecordField(
  context: DiagnosticSink,
  expectedType: RsglType,
  key: string,
  range: TextRange,
  computed = false
): void {
  const suggestion = closestExpectedField(key, expectedType.properties?.keys() ?? []);
  context.diagnostics.push(diagnostic(
    "rsgl.excessRecordField",
    `${computed ? "Computed record field" : "Record literal field"} '${key}' is not declared.${suggestion ? ` Did you mean '${suggestion}'?` : ""}`,
    range
  ));
}

function scoreContextualObjectArm(
  expression: ObjectExprNode,
  type: RsglType,
  scope: RsglScope
): ContextualObjectArmScore {
  const guaranteedNames = new Set<string>();
  let mismatches = 0;
  let excess = 0;
  let literalMatches = 0;
  for (const property of expression.properties) {
    if (property.kind === "ObjectSpread") {
      addStaticallyGuaranteedSpreadNames(guaranteedNames, property.expression, scope);
      continue;
    }
    const keys = contextualPropertyKeys(property, scope);
    if (keys?.length === 1) {
      guaranteedNames.add(keys[0]);
    }
    if (!keys?.length) {
      if (!type.open && !type.indexType) {
        excess++;
      }
      continue;
    }
    const actualType = contextualDiscriminatorValueType(property.value, scope);
    for (const key of keys) {
      const expected = expectedObjectValueType(type, key);
      if (!expected) {
        if (!type.open) {
          excess++;
        }
        continue;
      }
      if (actualType.kind !== "Unknown" && !isAssignable(expected, actualType)) {
        mismatches++;
      } else if (actualType.kind !== "Unknown" && hasOnlyLiteralOptions(expected)) {
        literalMatches++;
      }
    }
  }
  const missing = Array.from(type.properties ?? [])
    .filter(([name, property]) => !property.optional && !guaranteedNames.has(name))
    .length;
  return { type, mismatches, missing, excess, literalMatches };
}

function compareContextualObjectArmScores(
  left: ContextualObjectArmScore,
  right: ContextualObjectArmScore
): number {
  return left.mismatches - right.mismatches
    || (left.missing + left.excess) - (right.missing + right.excess)
    || left.missing - right.missing
    || left.excess - right.excess
    || right.literalMatches - left.literalMatches;
}

function contextualExpectationsEquivalent(
  expression: ObjectExprNode,
  scores: readonly ContextualObjectArmScore[],
  scope: RsglScope
): boolean {
  const keys = uniqueValues(expression.properties.flatMap(property =>
    property.kind === "ObjectSpread" ? [] : contextualPropertyKeys(property, scope) ?? []
  ));
  return keys.every(key => {
    const expectedKeys = scores.map(score => {
      const expected = expectedObjectValueType(score.type, key);
      return expected ? rsglTypeKey(expected) : "<untyped>";
    });
    return expectedKeys.every(expectedKey => expectedKey === expectedKeys[0]);
  });
}

function contextualPropertyKeys(property: ObjectPropertyNode, scope: RsglScope): string[] | undefined {
  const key = objectKeyName(property);
  if (key !== null) {
    return [key];
  }
  if (property.key.kind !== "DynamicKey") {
    return undefined;
  }
  const staticKey = staticIndexKey(property.key.expression);
  if (staticKey !== undefined) {
    return [staticKey];
  }
  if (property.key.expression.kind !== "IdentifierExpr") {
    return undefined;
  }
  const symbol = lookup(scope, property.key.expression.name.text);
  return symbol ? finiteObjectKeysFromType(symbol.type) : undefined;
}

function spreadSourceShape(
  expression: ExprNode,
  checkedType: RsglType,
  scope: RsglScope
): RsglType {
  if (expression.kind === "IdentifierExpr") {
    return lookup(scope, expression.name.text)?.type ?? checkedType;
  }
  return checkedType;
}

function isDynamicObjectType(type: RsglType): boolean {
  return type.kind === "Unknown" || type.kind === "Any";
}

function addGuaranteedSpreadNames(
  names: Set<string>,
  expression: ExprNode,
  types: readonly RsglType[]
): void {
  if (expression.kind === "ObjectExpr") {
    for (const property of expression.properties) {
      if (property.kind !== "ObjectSpread") {
        const name = objectKeyName(property);
        if (name !== null) {
          names.add(name);
        }
      }
    }
  }
  const requiredByEveryArm = Array.from(types[0]?.properties ?? [])
    .filter(([name, property]) =>
      !property.optional
      && types.every(type => type.properties?.get(name)?.optional === false)
    )
    .map(([name]) => name);
  requiredByEveryArm.forEach(name => names.add(name));
}

function addStaticallyGuaranteedSpreadNames(
  names: Set<string>,
  expression: ExprNode,
  scope: RsglScope
): void {
  if (expression.kind === "ObjectExpr") {
    for (const property of expression.properties) {
      if (property.kind !== "ObjectSpread") {
        const name = objectKeyName(property);
        if (name !== null) {
          names.add(name);
        }
      }
    }
    return;
  }
  const type = expression.kind === "IdentifierExpr"
    ? lookup(scope, expression.name.text)?.type
    : undefined;
  if (type?.kind === "Object") {
    for (const [name, property] of type.properties ?? []) {
      if (!property.optional) {
        names.add(name);
      }
    }
  }
}

function reportSpreadExcessFields(
  context: DiagnosticSink,
  expectedType: RsglType | undefined,
  spreadTypes: readonly RsglType[],
  range: TextRange
): void {
  if (!expectedType || expectedType.open || expectedType.indexType) {
    return;
  }
  const reported = new Set<string>();
  for (const spreadType of spreadTypes) {
    for (const name of spreadType.properties?.keys() ?? []) {
      if (!expectedType.properties?.has(name) && !reported.has(name)) {
        reported.add(name);
        reportExcessRecordField(context, expectedType, name, range);
      }
    }
  }
}

function contextualDiscriminatorValueType(expression: ExprNode, scope: RsglScope): RsglType {
  const literal = inferLiteralType(expression);
  if (literal.kind !== "Unknown") {
    return literal;
  }
  if (expression.kind === "IdentifierExpr") {
    return lookup(scope, expression.name.text)?.type ?? unknownType;
  }
  return unknownType;
}

function expectedObjectValueType(type: RsglType, key: string): RsglType | undefined {
  return type.properties?.get(key)?.type ?? type.indexType;
}

function hasOnlyLiteralOptions(type: RsglType): boolean {
  const options = type.kind === "Union" ? type.options ?? [] : [type];
  return options.length > 0 && options.every(hasLiteralValue);
}

function closestExpectedField(name: string, candidates: Iterable<string>): string | undefined {
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = simpleEditDistance(name, candidate);
    if (!best || distance < best.distance) {
      best = { candidate, distance };
    }
  }
  return best && best.distance <= Math.max(2, Math.floor(Math.max(name.length, best.candidate.length) / 3))
    ? best.candidate
    : undefined;
}

function simpleEditDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}
