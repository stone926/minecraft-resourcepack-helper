import type {
  ExprNode,
  ObjectExprNode,
  ObjectPropertyNode
} from "../parser";
import { diagnostic } from "./diagnostics";
import {
  checkExpression,
  type RsglExpressionCheckContext
} from "./expressionChecker";
import { lookup } from "./scopes";
import { combineRsglTypes } from "./typeNormalization";
import {
  type RsglScope,
  type RsglType,
  objectProperty,
  stringType
} from "./types";

export type BlockstateSelectorSyntax = "inlineObject" | "parenthesizedExpression";

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

  const properties = new Map<string, ReturnType<typeof objectProperty>>();
  const seenKeys = new Set<string>();
  let hasLogicalProperty = false;
  let hasStateProperty = false;

  for (const property of condition.properties) {
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
      hasLogicalProperty = true;
      properties.set(key, objectProperty(checkLogicalConditionValue(context, key, property.value, scope)));
      continue;
    }

    hasStateProperty = true;
    const valueType = checkStatePropertyValue(context, property.value, scope);
    if (!isPotentialStateScalar(valueType)) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidBlockstateSelectorValue",
        "Blockstate condition values must be scalar strings, numbers, or booleans.",
        property.value.range
      ));
    }
    if (key !== undefined) {
      properties.set(key, objectProperty(valueType));
    }
  }

  if (hasLogicalProperty && hasStateProperty) {
    context.diagnostics.push(diagnostic(
      "rsgl.mixedBlockstateWhenCondition",
      "Blockstate multipart OR/AND conditions cannot be mixed with state properties in the same object.",
      condition.range
    ));
  }
  return { kind: "Object", properties };
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
  const elementTypes = value.elements.map(element =>
    checkBlockstateCondition(context, element, scope)
  );
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
  const properties = new Map<string, ReturnType<typeof objectProperty>>();
  const seenKeys = new Set<string>();

  for (const property of expression.properties) {
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
      properties.set(key, objectProperty(valueType));
    }
  }

  return { kind: "Object", properties };
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
