import type {
  ExprNode,
  ObjectExprNode,
  ObjectPropertyNode,
  RsglNode
} from "../parser";
import { blockstateSelectorMessages } from "../diagnosticMessages";
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

const scalarSelectorValueMessage =
  "Blockstate selector values must be scalar strings, numbers, or booleans.";

/** Checks a structured variants selector without changing ordinary records. */
export function checkBlockstateSelector(
  context: RsglExpressionCheckContext,
  selector: ExprNode,
  scope: RsglScope
): RsglType {
  if (selector.kind === "ObjectExpr") {
    if (selector.properties.length === 0) {
      context.diagnostics.push(diagnostic(
        "rsgl.emptyBlockstateSelectorUseWildcard",
        blockstateSelectorMessages.emptySelectorUseWildcard,
        selector.range
      ));
    }
    return checkInlineStateObject(context, selector, scope);
  }

  const actualType = checkExpression(context, selector, scope);
  if (isDefinitelyNotStateObject(actualType)) {
    context.diagnostics.push(diagnostic(
      "rsgl.blockstateSelectorMustBeObject",
      "A blockstate variant selector must evaluate to a state record.",
      selector.range
    ));
    return actualType;
  }
  if (actualType.kind === "Object") {
    for (const property of actualType.properties?.values() ?? []) {
      if (!isPotentialStateScalar(property.type)) {
        context.diagnostics.push(diagnostic(
          "rsgl.invalidBlockstateSelectorValue",
          scalarSelectorValueMessage,
          selector.range
        ));
        break;
      }
    }
  }
  return actualType;
}

function checkInlineStateObject(
  context: RsglExpressionCheckContext,
  expression: ObjectExprNode,
  scope: RsglScope
): RsglType {
  let alternatives = [emptyObjectType()];
  const seenKeys = new Set<string>();

  for (const property of expression.properties) {
    if (property.kind === "ObjectSpread") {
      const spreadType = checkExpression(context, property.expression, scope);
      const spreadTypes = objectSpreadTypes(context, spreadType, property);
      if (spreadTypes) {
        for (const candidate of spreadTypes) {
          for (const spreadProperty of candidate.properties?.values() ?? []) {
            if (!isPotentialStateScalar(spreadProperty.type)) {
              context.diagnostics.push(diagnostic(
                "rsgl.invalidBlockstateSelectorValue",
                scalarSelectorValueMessage,
                property.range
              ));
            }
          }
        }
        alternatives = mergeObjectTypeAlternatives(
          { context, range: expression.range },
          alternatives,
          spreadTypes
        );
      }
      continue;
    }

    const key = checkStatePropertyKey(context, property, scope);
    if (key !== undefined) {
      if (seenKeys.has(key)) {
        context.diagnostics.push(diagnostic(
          "rsgl.duplicateBlockstateSelectorProperty",
          `Blockstate selector property '${key}' is declared more than once.`,
          property.key.range
        ));
      }
      seenKeys.add(key);
    }

    const valueType = checkStatePropertyValue(context, property, scope, key);
    if (!isPotentialStateScalar(valueType)) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidBlockstateSelectorValue",
        scalarSelectorValueMessage,
        property.value.range
      ));
    }
    if (key !== undefined) {
      alternatives = mergeObjectTypeAlternatives(
        { context, range: expression.range },
        alternatives,
        [{
          kind: "Object",
          properties: new Map([[key, objectProperty(valueType)]]),
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

function checkStatePropertyKey(
  context: RsglExpressionCheckContext,
  property: ObjectPropertyNode,
  scope: RsglScope
): string | undefined {
  if (property.key.kind !== "DynamicKey") {
    return staticPropertyKey(property);
  }
  const keyType = checkExpression(context, property.key.expression, scope);
  if (!isPotentialStateScalar(keyType)) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidBlockstateSelectorKey",
      blockstateSelectorMessages.computedKeyMustBeScalar,
      property.key.expression.range
    ));
  }
  return staticScalarText(property.key.expression);
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

function emptyObjectType(): RsglType {
  return { kind: "Object", properties: new Map(), open: false };
}

function staticPropertyKey(property: ObjectPropertyNode): string | undefined {
  if (property.key.kind === "Identifier") {
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  if (property.key.kind === "NumberLiteral") {
    return property.key.raw;
  }
  return undefined;
}

function staticScalarText(expression: ExprNode): string | undefined {
  if (expression.kind === "StringLiteral") {
    return expression.value;
  }
  if (expression.kind === "NumberLiteral") {
    return String(expression.value);
  }
  if (expression.kind === "BooleanLiteral") {
    return String(expression.value);
  }
  if (expression.kind === "ResourceLocationExpr") {
    return expression.value;
  }
  return undefined;
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

export type BlockstateSelectorNode = RsglNode;
