import type {
  ExprNode,
  ObjectExprNode,
  ObjectPropertyNode,
  RsglNode
} from "../parser";
import { mergeObjectTypeAlternatives } from "./collectionRecordTypes";
import { diagnostic } from "./diagnostics";
import {
  checkExpression,
  resolveListSpreadElementType,
  type RsglExpressionCheckContext
} from "./expressionChecker";
import { objectSpreadTypes } from "./objectSpreadTypes";
import { lookup } from "./scopes";
import { combineRsglTypes } from "./typeNormalization";
import { inferredUnionBudgetOptions } from "./unionBudget";
import {
  type RsglScope,
  type RsglType,
  objectProperty,
  stringType,
  unknownType
} from "./types";

export type BlockstateSelectorSyntax = "inlineObject" | "parenthesizedExpression";

const conditionLogicalKind = 1;
const conditionStateKind = 2;

/**
 * Checks the state-object domain without changing ordinary ObjectExpr rules.
 * In particular, an unbound identifier is an enum literal only in a selector
 * property value; computed keys and all other expression positions keep normal
 * symbol lookup semantics.
 */
export function checkBlockstateSelector(
  context: RsglExpressionCheckContext,
  selector: ExprNode,
  selectorSyntax: BlockstateSelectorSyntax,
  scope: RsglScope
): RsglType {
  if (selector.kind === "ObjectExpr") {
    return checkInlineStateObject(context, selector, scope);
  }

  const actualType = checkExpression(context, selector, scope);
  if (selectorSyntax === "inlineObject" || isDefinitelyNotStateObject(actualType)) {
    context.diagnostics.push(diagnostic(
      "rsgl.blockstateSelectorMustBeObject",
      "A blockstate variant selector must evaluate to a state object.",
      selector.range
    ));
    return actualType;
  }

  if (actualType.kind === "Object") {
    for (const property of actualType.properties?.values() ?? []) {
      if (!isPotentialStateScalar(property.type)) {
        context.diagnostics.push(diagnostic(
          "rsgl.invalidBlockstateSelectorValue",
          "Blockstate selector values must be scalar strings, numbers, or booleans.",
          selector.range
        ));
        break;
      }
    }
  }
  return actualType;
}

/**
 * Checks a multipart `when` expression with the same contextual state-value
 * rules as a variants selector. Logical OR/AND arrays recurse into condition
 * objects without making ordinary object expressions globally contextual.
 */
export function checkBlockstateCondition(
  context: RsglExpressionCheckContext,
  condition: ExprNode,
  scope: RsglScope
): RsglType {
  if (condition.kind !== "ObjectExpr") {
    const actualType = checkExpression(context, condition, scope);
    if (isDefinitelyNotStateObject(actualType)) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidBlockstateCondition",
        "A blockstate multipart condition must evaluate to an object.",
        condition.range
      ));
    }
    return actualType;
  }

  if (condition.properties.length === 0) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidBlockstateWhen",
      "A blockstate multipart condition must be a non-empty object.",
      condition.range
    ));
  }

  let alternatives = [emptyObjectType()];
  const seenKeys = new Set<string>();
  let possibleKinds = new Set([0]);

  for (const property of condition.properties) {
    if (property.kind === "ObjectSpread") {
      const spreadTypes = checkBlockstateObjectSpread(context, property.expression, scope, property);
      if (spreadTypes) {
        possibleKinds = combineConditionKinds(
          possibleKinds,
          spreadTypes.map(conditionKindForObjectType)
        );
        alternatives = mergeObjectTypeAlternatives({
          context,
          range: condition.range
        }, alternatives, spreadTypes);
      }
      continue;
    }
    const key = checkStatePropertyKey(context, property, scope);
    if (key !== undefined) {
      if (seenKeys.has(key)) {
        context.diagnostics.push(diagnostic(
          "rsgl.duplicateBlockstateSelectorProperty",
          `Blockstate condition property '${key}' is declared more than once.`,
          property.key.range
        ));
      }
      seenKeys.add(key);
    }

    if (key === "OR" || key === "AND") {
      possibleKinds = addConditionKind(possibleKinds, conditionLogicalKind);
      const valueType = checkLogicalConditionValue(context, key, property.value, scope);
      alternatives = mergeKnownObjectProperty(
        context,
        alternatives,
        key,
        valueType,
        condition.range
      );
      continue;
    }

    possibleKinds = addConditionKind(possibleKinds, conditionStateKind);
    const valueType = checkStatePropertyValue(context, property.value, scope);
    if (!isPotentialStateScalar(valueType)) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidBlockstateSelectorValue",
        "Blockstate condition values must be scalar strings, numbers, or booleans.",
        property.value.range
      ));
    }
    if (key !== undefined) {
      alternatives = mergeKnownObjectProperty(
        context,
        alternatives,
        key,
        valueType,
        condition.range
      );
    }
  }

  if (possibleKinds.has(conditionLogicalKind | conditionStateKind)) {
    context.diagnostics.push(diagnostic(
      "rsgl.mixedBlockstateWhenCondition",
      "Blockstate multipart OR/AND conditions cannot be mixed with state properties in the same object.",
      condition.range
    ));
  }
  return combineObjectAlternatives(context, alternatives, condition.range);
}

function checkLogicalConditionValue(
  context: RsglExpressionCheckContext,
  operator: "OR" | "AND",
  value: ExprNode,
  scope: RsglScope
): RsglType {
  if (value.kind !== "ListExpr") {
    const actualType = checkExpression(context, value, scope);
    context.diagnostics.push(diagnostic(
      "rsgl.invalidBlockstateLogicalCondition",
      `Blockstate multipart ${operator} must be a non-empty list of condition objects.`,
      value.range
    ));
    return actualType;
  }

  if (value.elements.length === 0) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidBlockstateLogicalCondition",
      `Blockstate multipart ${operator} must be a non-empty list of condition objects.`,
      value.range
    ));
  }
  const elementTypes = value.elements.map(element => {
    if (element.kind !== "ListSpread") {
      return checkBlockstateCondition(context, element, scope);
    }
    const spreadType = checkExpression(context, element.expression, scope);
    const elementType = resolveListSpreadElementType(context, spreadType, element);
    if (elementType) {
      if (isDefinitelyNotStateObject(elementType)) {
        context.diagnostics.push(diagnostic(
          "rsgl.invalidBlockstateLogicalCondition",
          `Blockstate multipart ${operator} list spread must contain condition objects.`,
          element.range
        ));
      }
      return elementType;
    }
    return unknownType;
  });
  return {
    kind: "List",
    elementType: combineRsglTypes(elementTypes)
  };
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
      const spreadTypes = checkBlockstateObjectSpread(context, property.expression, scope, property);
      if (spreadTypes) {
        for (const spreadType of spreadTypes) {
          for (const spreadProperty of spreadType.properties?.values() ?? []) {
            if (!isPotentialStateScalar(spreadProperty.type)) {
              context.diagnostics.push(diagnostic(
                "rsgl.invalidBlockstateSelectorValue",
                "Blockstate selector values must be scalar strings, numbers, or booleans.",
                property.range
              ));
            }
          }
        }
        alternatives = mergeObjectTypeAlternatives({
          context,
          range: expression.range
        }, alternatives, spreadTypes);
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

    const valueType = checkStatePropertyValue(context, property.value, scope);
    if (!isPotentialStateScalar(valueType)) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidBlockstateSelectorValue",
        "Blockstate selector values must be scalar strings, numbers, or booleans.",
        property.value.range
      ));
    }
    if (key !== undefined) {
      alternatives = mergeKnownObjectProperty(
        context,
        alternatives,
        key,
        valueType,
        expression.range
      );
    }
  }

  return combineObjectAlternatives(context, alternatives, expression.range);
}

function checkBlockstateObjectSpread(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope,
  spread: RsglNode
): RsglType[] | undefined {
  const type = checkExpression(context, expression, scope);
  return objectSpreadTypes(context, type, spread);
}

function emptyObjectType(): RsglType {
  return { kind: "Object", properties: new Map(), open: false };
}

function mergeKnownObjectProperty(
  context: RsglExpressionCheckContext,
  alternatives: readonly RsglType[],
  key: string,
  valueType: RsglType,
  range: RsglNode["range"]
): RsglType[] {
  return mergeObjectTypeAlternatives({ context, range }, alternatives, [{
    kind: "Object",
    properties: new Map([[key, objectProperty(valueType)]]),
    open: false
  }]);
}

function combineObjectAlternatives(
  context: RsglExpressionCheckContext,
  alternatives: readonly RsglType[],
  range: RsglNode["range"]
): RsglType {
  return combineRsglTypes(
    alternatives,
    false,
    inferredUnionBudgetOptions(context.diagnostics, range)
  );
}

function conditionKindForObjectType(type: RsglType): number {
  let kind = 0;
  for (const key of type.properties?.keys() ?? []) {
    kind |= key === "OR" || key === "AND"
      ? conditionLogicalKind
      : conditionStateKind;
  }
  return kind;
}

function combineConditionKinds(
  earlier: ReadonlySet<number>,
  later: readonly number[]
): Set<number> {
  const combined = new Set<number>();
  for (const left of earlier) {
    for (const right of later) {
      combined.add(left | right);
    }
  }
  return combined;
}

function addConditionKind(kinds: ReadonlySet<number>, kind: number): Set<number> {
  return new Set(Array.from(kinds, existing => existing | kind));
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
      "A computed blockstate selector key must evaluate to a scalar value.",
      property.key.expression.range
    ));
  }
  return staticScalarText(property.key.expression);
}

function checkStatePropertyValue(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
    return stringType;
  }
  return checkExpression(context, expression, scope);
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
