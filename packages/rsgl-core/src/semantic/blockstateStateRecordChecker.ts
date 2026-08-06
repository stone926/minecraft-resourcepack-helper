import { uniqueValues } from "../../../mc-assets/src";
import type {
  ExprNode,
  ObjectExprNode,
  ObjectPropertyNode,
  TextRange
} from "../parser";
import {
  blockstateSelectorMessages,
  blockstateStateRecordMessages
} from "../diagnosticMessages";
import { mergeObjectTypeAlternatives } from "./collectionRecordTypes";
import { diagnostic } from "./diagnostics";
import { checkExpression } from "./expressionChecker";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { objectSpreadTypes } from "./objectSpreadTypes";
import { lookup } from "./scopes";
import { combineRsglTypes } from "./typeNormalization";
import { inferredUnionBudgetOptions } from "./unionBudget";
import {
  type RsglScope,
  type RsglType,
  objectProperty,
  stringType
} from "./types";

export type BlockstateStateRecordRole = "selector" | "multipart";

interface StateRecordPolicy {
  readonly mustBeObjectCode: string;
  readonly mustBeObjectMessage: string;
  readonly invalidValueCode: string;
  readonly invalidValueMessage: string;
  readonly invalidKeyCode: string;
  readonly invalidKeyMessage: string;
  readonly duplicateKeyCode: string;
  readonly duplicateKeyMessage: (key: string) => string;
  readonly emptyCode: string;
  readonly emptyMessage: string;
  readonly unverifiableSpreadCode: string;
  readonly unverifiableSpreadMessage: string;
  readonly rejectRawConditionEncoding: boolean;
}

const selectorPolicy: StateRecordPolicy = {
  mustBeObjectCode: "rsgl.blockstateSelectorMustBeObject",
  mustBeObjectMessage: "A blockstate variant selector must evaluate to a state record.",
  invalidValueCode: "rsgl.invalidBlockstateSelectorValue",
  invalidValueMessage: blockstateStateRecordMessages.selectorValueMustBeScalar,
  invalidKeyCode: "rsgl.invalidBlockstateSelectorKey",
  invalidKeyMessage: blockstateSelectorMessages.computedKeyMustBeScalar,
  duplicateKeyCode: "rsgl.duplicateBlockstateSelectorProperty",
  duplicateKeyMessage: key => `Blockstate selector property '${key}' is declared more than once.`,
  emptyCode: "rsgl.emptyBlockstateSelectorUseWildcard",
  emptyMessage: blockstateSelectorMessages.emptySelectorUseWildcard,
  unverifiableSpreadCode: "rsgl.unverifiableBlockstateSelectorSpread",
  unverifiableSpreadMessage: blockstateStateRecordMessages.selectorSpreadMustBeVerifiable,
  rejectRawConditionEncoding: false
};

const multipartPolicy: StateRecordPolicy = {
  mustBeObjectCode: "rsgl.multipartStateRecordMustBeObject",
  mustBeObjectMessage: blockstateStateRecordMessages.multipartMustBeObject,
  invalidValueCode: "rsgl.invalidMultipartStateRecordValue",
  invalidValueMessage: blockstateStateRecordMessages.multipartValueMustBeScalar,
  invalidKeyCode: "rsgl.invalidMultipartStateRecordKey",
  invalidKeyMessage: blockstateStateRecordMessages.multipartComputedKeyMustBeScalar,
  duplicateKeyCode: "rsgl.duplicateMultipartStateRecordProperty",
  duplicateKeyMessage: key => `Multipart state record property '${key}' is declared more than once.`,
  emptyCode: "rsgl.emptyMultipartStateRecordUseAlways",
  emptyMessage: blockstateStateRecordMessages.emptyMultipartUseAlways,
  unverifiableSpreadCode: "rsgl.unverifiableMultipartStateRecordSpread",
  unverifiableSpreadMessage: blockstateStateRecordMessages.multipartSpreadMustBeVerifiable,
  rejectRawConditionEncoding: true
};

/**
 * Checks a compile-time blockstate state record without changing ordinary
 * object-expression semantics. Variants selectors and multipart equality
 * conditions deliberately share this implementation.
 */
export function checkBlockstateStateRecord(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  role: BlockstateStateRecordRole
): RsglType {
  const policy = role === "selector" ? selectorPolicy : multipartPolicy;
  if (expression.kind === "ObjectExpr") {
    if (expression.properties.length === 0) {
      context.diagnostics.push(diagnostic(
        policy.emptyCode,
        policy.emptyMessage,
        expression.range
      ));
    }
    return checkInlineStateObject(context, expression, scope, policy);
  }

  const actualType = checkExpression(context, expression, scope);
  if (isDefinitelyNotStateObject(actualType)) {
    context.diagnostics.push(diagnostic(
      policy.mustBeObjectCode,
      policy.mustBeObjectMessage,
      expression.range
    ));
    return actualType;
  }
  if (actualType.kind === "Object") {
    checkObjectTypeProperties(context, actualType, expression.range, policy);
  }
  return actualType;
}

function checkInlineStateObject(
  context: RsglExpressionCheckContext,
  expression: ObjectExprNode,
  scope: RsglScope,
  policy: StateRecordPolicy
): RsglType {
  let alternatives = [emptyObjectType()];
  const possibleKeys = new Set<string>();
  let hasUnresolvedComputedKey = false;
  let hasSpread = false;

  for (const property of expression.properties) {
    if (property.kind === "ObjectSpread") {
      const spreadType = checkExpression(context, property.expression, scope);
      const spreadTypes = objectSpreadTypes(context, spreadType, property);
      if (spreadTypes) {
        const verifiable = spreadTypes.every(isClosedStateRecordType);
        if (!verifiable || hasUnresolvedComputedKey) {
          context.diagnostics.push(diagnostic(
            policy.unverifiableSpreadCode,
            policy.unverifiableSpreadMessage,
            property.range
          ));
        }

        const spreadKeys = new Set<string>();
        for (const candidate of spreadTypes) {
          checkObjectTypeProperties(context, candidate, property.range, policy);
          for (const key of candidate.properties?.keys() ?? []) {
            spreadKeys.add(key);
          }
        }
        reportDuplicatePossibleKeys(context, spreadKeys, possibleKeys, property.range, policy);
        spreadKeys.forEach(key => possibleKeys.add(key));
        alternatives = mergeObjectTypeAlternatives(
          { context, range: expression.range },
          alternatives,
          spreadTypes
        );
      }
      hasSpread = true;
      continue;
    }

    const keyInfo = checkStatePropertyKey(context, property, scope, policy);
    if (!keyInfo.possibleKeys) {
      hasUnresolvedComputedKey ||= property.key.kind === "DynamicKey";
      if (hasSpread && property.key.kind === "DynamicKey") {
        context.diagnostics.push(diagnostic(
          policy.unverifiableSpreadCode,
          policy.unverifiableSpreadMessage,
          property.key.range
        ));
      }
    } else {
      reportDuplicatePossibleKeys(
        context,
        keyInfo.possibleKeys,
        possibleKeys,
        property.key.range,
        policy
      );
      for (const key of keyInfo.possibleKeys) {
        possibleKeys.add(key);
        checkRawLogicalKey(context, key, property.key.range, policy);
      }
    }

    const propertyName = keyInfo.possibleKeys?.length === 1
      ? keyInfo.possibleKeys[0]
      : undefined;
    const valueType = checkStatePropertyValue(context, property, scope, propertyName);
    if (!isPotentialStateScalar(valueType)) {
      context.diagnostics.push(diagnostic(
        policy.invalidValueCode,
        policy.invalidValueMessage,
        property.value.range
      ));
    }
    checkRawEncodedValueType(context, valueType, property.value.range, policy);
    if (propertyName !== undefined) {
      alternatives = mergeObjectTypeAlternatives(
        { context, range: expression.range },
        alternatives,
        [{
          kind: "Object",
          properties: new Map([[propertyName, objectProperty(valueType)]]),
          open: false
        }]
      );
    }
  }

  return combineRsglTypes(
    alternatives,
    false,
    inferredUnionBudgetOptions(context.diagnostics, expression.range)
  );
}

function checkObjectTypeProperties(
  context: RsglExpressionCheckContext,
  type: RsglType,
  range: TextRange,
  policy: StateRecordPolicy
): void {
  for (const [key, property] of type.properties ?? []) {
    if (!isPotentialStateScalar(property.type)) {
      context.diagnostics.push(diagnostic(
        policy.invalidValueCode,
        policy.invalidValueMessage,
        range
      ));
    }
    checkRawLogicalKey(context, key, range, policy);
    checkRawEncodedValueType(context, property.type, range, policy);
  }
  if (type.indexType && !isPotentialStateScalar(type.indexType)) {
    context.diagnostics.push(diagnostic(
      policy.invalidValueCode,
      policy.invalidValueMessage,
      range
    ));
  }
}

function checkStatePropertyKey(
  context: RsglExpressionCheckContext,
  property: ObjectPropertyNode,
  scope: RsglScope,
  policy: StateRecordPolicy
): { possibleKeys?: string[] } {
  if (property.key.kind !== "DynamicKey") {
    return { possibleKeys: [staticPropertyKey(property)] };
  }
  const keyType = checkExpression(context, property.key.expression, scope);
  if (!isPotentialStateScalar(keyType)) {
    context.diagnostics.push(diagnostic(
      policy.invalidKeyCode,
      policy.invalidKeyMessage,
      property.key.range
    ));
  }
  return { possibleKeys: scalarLiteralTexts(keyType) };
}

function checkStatePropertyValue(
  context: RsglExpressionCheckContext,
  property: ObjectPropertyNode,
  scope: RsglScope,
  propertyName?: string
): RsglType {
  const expression = property.value;
  const symbol = expression.kind === "IdentifierExpr"
    ? lookup(scope, expression.name.text)
    : undefined;
  if (expression.kind === "IdentifierExpr" && !symbol) {
    return stringType;
  }
  if (
    !property.shorthand
    && symbol?.node?.kind === "LetDecl"
    && expression.kind === "IdentifierExpr"
    && propertyName !== expression.name.text
    && /^[a-z][a-z0-9_]*$/.test(expression.name.text)
  ) {
    context.diagnostics.push(diagnostic(
      "rsgl.blockstateEnumLiteralShadowed",
      `Local '${expression.name.text}' shadows a bare blockstate enum literal with the same spelling; rename it or make the intended value explicit.`,
      expression.range,
      "warning"
    ));
  }
  return checkExpression(context, expression, scope);
}

function reportDuplicatePossibleKeys(
  context: RsglExpressionCheckContext,
  incoming: Iterable<string>,
  existing: ReadonlySet<string>,
  range: TextRange,
  policy: StateRecordPolicy
): void {
  for (const key of incoming) {
    if (!existing.has(key)) {
      continue;
    }
    context.diagnostics.push(diagnostic(
      policy.duplicateKeyCode,
      policy.duplicateKeyMessage(key),
      range
    ));
    return;
  }
}

function checkRawLogicalKey(
  context: RsglExpressionCheckContext,
  key: string,
  range: TextRange,
  policy: StateRecordPolicy
): void {
  if (!policy.rejectRawConditionEncoding || (key !== "OR" && key !== "AND")) {
    return;
  }
  context.diagnostics.push(diagnostic(
    "rsgl.rawMultipartStateRecordLogicalKey",
    blockstateStateRecordMessages.multipartRawLogicalKey,
    range
  ));
}

function checkRawEncodedValueType(
  context: RsglExpressionCheckContext,
  type: RsglType,
  range: TextRange,
  policy: StateRecordPolicy
): void {
  if (!policy.rejectRawConditionEncoding) {
    return;
  }
  const texts = scalarLiteralTexts(type);
  if (!texts?.some(isRawConditionEncoding)) {
    return;
  }
  context.diagnostics.push(diagnostic(
    "rsgl.rawMultipartStateRecordValue",
    blockstateStateRecordMessages.multipartRawEncodedValue,
    range
  ));
}

function isRawConditionEncoding(value: string): boolean {
  return value.includes("|") || value.startsWith("!");
}

function emptyObjectType(): RsglType {
  return { kind: "Object", properties: new Map(), open: false };
}

function staticPropertyKey(property: ObjectPropertyNode): string {
  if (property.key.kind === "Identifier") {
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  if (property.key.kind === "NumberLiteral") {
    return property.key.raw;
  }
  throw new Error("Dynamic blockstate state-record key must be checked separately.");
}

function scalarLiteralTexts(type: RsglType): string[] | undefined {
  if (type.kind === "Union") {
    const values = (type.options ?? []).map(scalarLiteralTexts);
    return values.every((value): value is string[] => value !== undefined)
      ? uniqueValues(values.flat())
      : undefined;
  }
  if (type.literalValue === undefined || type.literalValue === null) {
    return undefined;
  }
  return [String(type.literalValue)];
}

function isClosedStateRecordType(type: RsglType): boolean {
  return type.kind === "Object" && !type.open && !type.indexType;
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

function isDefinitelyNotStateObject(type: RsglType): boolean {
  if (type.kind === "Union") {
    return (type.options ?? []).some(isDefinitelyNotStateObject);
  }
  return type.kind !== "Object"
    && type.kind !== "Any"
    && type.kind !== "Unknown"
    && type.kind !== "Json";
}
