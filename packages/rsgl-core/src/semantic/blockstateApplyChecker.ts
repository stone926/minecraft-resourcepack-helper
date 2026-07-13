import type {
  BlockstateApplyValueNode,
  BlockstateModelPropertyNode,
  ExprNode,
  ListExprNode,
  ObjectExprNode,
  ObjectPropertyNode,
  TextRange
} from "../parser";
import {
  isBlockstateModelModifierField,
  isBlockstateModelObjectField,
  isBlockstateQuarterTurn,
  isPositiveInteger
} from "../blockstateModelDomain";
import { diagnostic } from "./diagnostics";
import {
  checkExpression,
  checkExpressionForExpectedType,
  type RsglExpressionCheckContext
} from "./expressionChecker";
import { combineRsglTypes } from "./typeNormalization";
import { formatType, isAssignable } from "./typeRelations";
import {
  blockstateModelObjectType,
  booleanType,
  jsonType,
  modelIdType,
  numberType,
  type RsglBlockstateApplyExpectation,
  type RsglBlockstateApplyFact,
  type RsglBlockstateApplySiteNode,
  type RsglScope,
  type RsglType,
  unknownType
} from "./types";

export type RsglBlockstateApplyFactRecorder = (
  node: RsglBlockstateApplySiteNode,
  scope: RsglScope,
  fact: RsglBlockstateApplyFact
) => void;

/** Checks the non-global blockstate apply/random AST domain. */
export function checkBlockstateApplyValue(
  context: RsglExpressionCheckContext,
  value: BlockstateApplyValueNode,
  scope: RsglScope,
  recordFact: RsglBlockstateApplyFactRecorder
): void {
  if (value.kind === "BlockstateApplyExpr") {
    checkBlockstateApplySite(context, value, scope, "modelOrObjectOrFlatList", recordFact);
    return;
  }

  if (value.items.length === 0) {
    context.diagnostics.push(diagnostic(
      "rsgl.emptyBlockstateRandom",
      "A blockstate random value must contain at least one model.",
      value.range
    ));
  }
  for (const item of value.items) {
    checkBlockstateApplySite(context, item, scope, "modelOrObject", recordFact);
  }
}

/** Reusable entry point for the post-link import/re-export validation pass. */
export function checkBlockstateApplySite(
  context: RsglExpressionCheckContext,
  node: RsglBlockstateApplySiteNode,
  scope: RsglScope,
  baseExpectation: Exclude<RsglBlockstateApplyExpectation, "modelIdOnly">,
  recordFact: RsglBlockstateApplyFactRecorder
): RsglBlockstateApplyFact {
  checkModifierProperties(context, node.properties, scope);
  const expectation: RsglBlockstateApplyExpectation = node.properties.length > 0
    ? "modelIdOnly"
    : baseExpectation;
  const actualType = expectation === "modelIdOnly"
    ? checkModelIdOnlyHead(context, node.head, scope)
    : checkCompositeHead(context, node.head, scope, expectation);
  const fact: RsglBlockstateApplyFact = {
    expectation,
    actualType,
    unknownFields: containsExplicitJson(actualType)
      ? "preserveExplicitJson"
      : "reject"
  };
  recordFact(node, scope, fact);
  return fact;
}

function checkModelIdOnlyHead(
  context: RsglExpressionCheckContext,
  head: ExprNode,
  scope: RsglScope
): RsglType {
  const actualType = checkExpressionForExpectedType(context, head, scope, modelIdType);
  if (!isAssignable(modelIdType, actualType)) {
    if (!reportModelIdKindMismatch(context, actualType, head.range)) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidBlockstateApplyHead",
        `Blockstate apply modifiers require a ModelId head, got ${formatType(actualType)}.`,
        head.range
      ));
    }
  }
  return actualType;
}

function checkCompositeHead(
  context: RsglExpressionCheckContext,
  head: ExprNode,
  scope: RsglScope,
  expectation: "modelOrObject" | "modelOrObjectOrFlatList"
): RsglType {
  if (head.kind === "ObjectExpr") {
    return checkModelObjectExpression(context, head, scope);
  }
  if (head.kind === "ListExpr") {
    if (expectation === "modelOrObject") {
      checkExpression(context, head, scope);
      context.diagnostics.push(diagnostic(
        "rsgl.nestedBlockstateModelList",
        "A blockstate random item cannot contain a model-object list.",
        head.range
      ));
      return { kind: "List", elementType: unknownType };
    }
    return checkModelObjectList(context, head, scope);
  }

  const actualType = checkPotentialModelExpression(context, head, scope);
  validateCompositeType(context, actualType, expectation, head.range);
  return actualType;
}

function checkPotentialModelExpression(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  return checkExpressionForExpectedType(context, expression, scope, blockstateCompositeHeadType);
}

const blockstateCompositeHeadType: RsglType = {
  kind: "Union",
  options: [
    modelIdType,
    blockstateModelObjectType,
    { kind: "Object", open: true, indexType: jsonType },
    { kind: "List", elementType: jsonType }
  ]
};

function validateCompositeType(
  context: RsglExpressionCheckContext,
  actualType: RsglType,
  expectation: "modelOrObject" | "modelOrObjectOrFlatList",
  range: TextRange
): void {
  if (actualType.kind === "Union") {
    for (const option of actualType.options ?? []) {
      validateCompositeType(context, option, expectation, range);
    }
    return;
  }
  if (isAssignable(modelIdType, actualType) || actualType.kind === "BlockstateModelObject") {
    return;
  }
  if (actualType.kind === "Object") {
    validateStructuralModelObject(context, actualType, range);
    return;
  }
  if (actualType.kind === "List") {
    if (expectation === "modelOrObject") {
      context.diagnostics.push(diagnostic(
        "rsgl.nestedBlockstateModelList",
        "A blockstate random item cannot contain a model-object list.",
        range
      ));
      return;
    }
    validateModelListElementType(context, actualType.elementType ?? unknownType, range);
    return;
  }
  if (actualType.kind === "Json" || actualType.kind === "Any" || actualType.kind === "Unknown") {
    return;
  }
  if (reportModelIdKindMismatch(context, actualType, range)) {
    return;
  }
  context.diagnostics.push(diagnostic(
    "rsgl.invalidBlockstateApplyHead",
    `Expected a ModelId or blockstate model object, got ${formatType(actualType)}.`,
    range
  ));
}

function checkModelObjectList(
  context: RsglExpressionCheckContext,
  list: ListExprNode,
  scope: RsglScope
): RsglType {
  if (list.elements.length === 0) {
    context.diagnostics.push(diagnostic(
      "rsgl.emptyBlockstateModelList",
      "A blockstate model-object list must not be empty.",
      list.range
    ));
    return { kind: "List", elementType: blockstateModelObjectType };
  }

  const elementTypes: RsglType[] = [];
  for (const element of list.elements) {
    if (element.kind === "ListExpr") {
      checkExpression(context, element, scope);
      context.diagnostics.push(diagnostic(
        "rsgl.nestedBlockstateModelList",
        "Blockstate model-object lists must be flat.",
        element.range
      ));
      elementTypes.push({ kind: "List", elementType: unknownType });
      continue;
    }
    if (element.kind === "ObjectExpr") {
      elementTypes.push(checkModelObjectExpression(context, element, scope));
      continue;
    }
    const elementType = checkExpression(context, element, scope);
    elementTypes.push(elementType);
    validateModelListElementType(context, elementType, element.range);
  }
  return { kind: "List", elementType: combineRsglTypes(elementTypes) };
}

function validateModelListElementType(
  context: RsglExpressionCheckContext,
  elementType: RsglType,
  range: TextRange
): void {
  if (elementType.kind === "Union") {
    for (const option of elementType.options ?? []) {
      validateModelListElementType(context, option, range);
    }
    return;
  }
  if (elementType.kind === "BlockstateModelObject") {
    return;
  }
  if (elementType.kind === "Object") {
    validateStructuralModelObject(context, elementType, range);
    return;
  }
  if (elementType.kind === "List") {
    context.diagnostics.push(diagnostic(
      "rsgl.nestedBlockstateModelList",
      "Blockstate model-object lists must be flat.",
      range
    ));
    return;
  }
  if (elementType.kind === "Json" || elementType.kind === "Any" || elementType.kind === "Unknown") {
    return;
  }
  context.diagnostics.push(diagnostic(
    "rsgl.invalidBlockstateApplyHead",
    `Blockstate model-object lists cannot contain ${formatType(elementType)} values.`,
    range
  ));
}

function checkModelObjectExpression(
  context: RsglExpressionCheckContext,
  expression: ObjectExprNode,
  scope: RsglScope
): RsglType {
  const seen = new Set<string>();
  let hasModel = false;
  let hasDynamicKey = false;

  for (const property of expression.properties) {
    if (property.key.kind === "DynamicKey") {
      hasDynamicKey = true;
      checkExpression(context, property.key.expression, scope);
      checkExpression(context, property.value, scope);
      context.diagnostics.push(diagnostic(
        "rsgl.unknownBlockstateModelField",
        "Computed fields are not allowed in a closed blockstate model object.",
        property.key.range
      ));
      continue;
    }
    const name = modelObjectPropertyName(property);
    if (name === undefined) {
      continue;
    }
    if (seen.has(name)) {
      context.diagnostics.push(diagnostic(
        "rsgl.duplicateBlockstateModelField",
        `Blockstate model field '${name}' is declared more than once.`,
        property.key.range
      ));
    }
    seen.add(name);
    hasModel ||= name === "model";
    checkModelObjectField(context, name, property.value, scope, property.key.range);
  }

  if (!hasModel && !hasDynamicKey) {
    context.diagnostics.push(diagnostic(
      "rsgl.missingBlockstateModel",
      "A blockstate model object requires a 'model' field.",
      expression.range
    ));
  }
  return blockstateModelObjectType;
}

function checkModelObjectField(
  context: RsglExpressionCheckContext,
  name: string,
  value: ExprNode,
  scope: RsglScope,
  nameRange: TextRange
): void {
  if (!isBlockstateModelObjectField(name)) {
    checkExpression(context, value, scope);
    context.diagnostics.push(diagnostic(
      "rsgl.unknownBlockstateModelField",
      `Unknown blockstate model field '${name}'.`,
      nameRange
    ));
    return;
  }
  if (name === "model") {
    const actualType = checkExpressionForExpectedType(context, value, scope, modelIdType);
    if (!isAssignable(modelIdType, actualType)) {
      if (!reportModelIdKindMismatch(context, actualType, value.range)) {
        context.diagnostics.push(diagnostic(
          "rsgl.invalidBlockstateApplyHead",
          `Blockstate model field 'model' requires ModelId, got ${formatType(actualType)}.`,
          value.range
        ));
      }
    }
    return;
  }
  checkKnownModelProperty(context, name, value, scope);
}

function checkModifierProperties(
  context: RsglExpressionCheckContext,
  properties: readonly BlockstateModelPropertyNode[],
  scope: RsglScope
): void {
  const seen = new Set<string>();
  for (const property of properties) {
    const name = property.name.text;
    if (seen.has(name)) {
      context.diagnostics.push(diagnostic(
        "rsgl.duplicateBlockstateModelField",
        `Blockstate model field '${name}' is declared more than once.`,
        property.name.range
      ));
    }
    seen.add(name);
    if (!isBlockstateModelModifierField(name)) {
      checkExpression(context, property.value, scope);
      context.diagnostics.push(diagnostic(
        "rsgl.unknownBlockstateModelField",
        `Unknown blockstate model modifier '${name}'.`,
        property.name.range
      ));
      continue;
    }
    checkKnownModelProperty(context, name, property.value, scope);
  }
}

function checkKnownModelProperty(
  context: RsglExpressionCheckContext,
  name: "x" | "y" | "z" | "uvlock" | "weight",
  value: ExprNode,
  scope: RsglScope
): void {
  const expectedType = name === "uvlock" ? booleanType : numberType;
  const actualType = checkExpression(context, value, scope);
  if (!isAssignable(expectedType, actualType)) {
    const code = name === "uvlock"
      ? "rsgl.invalidBlockstateUvlock"
      : name === "weight"
        ? "rsgl.invalidRandomWeight"
        : "rsgl.invalidBlockstateRotation";
    context.diagnostics.push(diagnostic(
      code,
      `Blockstate model '${name}' has an invalid ${formatType(actualType)} value.`,
      value.range
    ));
    return;
  }
  if (value.kind !== "NumberLiteral") {
    return;
  }
  if ((name === "x" || name === "y" || name === "z") && !isBlockstateQuarterTurn(value.value)) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidBlockstateRotation",
      `Blockstate model ${name} rotation must be one of 0, 90, 180, or 270.`,
      value.range
    ));
  } else if (name === "weight" && !isPositiveInteger(value.value)) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidRandomWeight",
      "Random model weight must be a positive integer.",
      value.range
    ));
  }
}

function validateStructuralModelObject(
  context: RsglExpressionCheckContext,
  type: RsglType,
  range: TextRange
): void {
  const properties = type.properties ?? new Map();
  if (!properties.has("model")) {
    context.diagnostics.push(diagnostic(
      "rsgl.missingBlockstateModel",
      "A blockstate model object requires a 'model' field.",
      range
    ));
  }
  for (const [name, property] of properties) {
    const valueType = property.type;
    if (!isBlockstateModelObjectField(name)) {
      context.diagnostics.push(diagnostic(
        "rsgl.unknownBlockstateModelField",
        `Unknown blockstate model field '${name}'.`,
        range
      ));
      continue;
    }
    if (
      name === "model"
      && !isAssignable(modelIdType, valueType)
      && !isContextualModelIdTextType(valueType)
    ) {
      if (!reportModelIdKindMismatch(context, valueType, range)) {
        context.diagnostics.push(diagnostic(
          "rsgl.invalidBlockstateApplyHead",
          `Blockstate model field 'model' requires ModelId, got ${formatType(valueType)}.`,
          range
        ));
      }
    } else if (name === "uvlock" && !isAssignable(booleanType, valueType)) {
      context.diagnostics.push(diagnostic(
        "rsgl.invalidBlockstateUvlock",
        "Blockstate model uvlock must be a boolean.",
        range
      ));
    } else if ((name === "x" || name === "y" || name === "z" || name === "weight")
      && !isAssignable(numberType, valueType)) {
      context.diagnostics.push(diagnostic(
        name === "weight" ? "rsgl.invalidRandomWeight" : "rsgl.invalidBlockstateRotation",
        `Blockstate model '${name}' must be a number.`,
        range
      ));
    }
  }
}

function isContextualModelIdTextType(type: RsglType): boolean {
  if (type.kind === "String") {
    return true;
  }
  return type.kind === "Union"
    && (type.options?.length ?? 0) > 0
    && (type.options ?? []).every(option =>
      isAssignable(modelIdType, option) || isContextualModelIdTextType(option)
    );
}

function reportModelIdKindMismatch(
  context: RsglExpressionCheckContext,
  actualType: RsglType,
  range: TextRange
): boolean {
  if (actualType.kind !== "ResourceId" && actualType.kind !== "TextureId") {
    return false;
  }
  context.diagnostics.push(diagnostic(
    "rsgl.resourceIdKindMismatch",
    `${actualType.kind} cannot be used where ModelId is required.`,
    range
  ));
  return true;
}

function modelObjectPropertyName(property: ObjectPropertyNode): string | undefined {
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

function containsExplicitJson(type: RsglType): boolean {
  if (type.kind === "Json") {
    return type.explicitAnnotation === true;
  }
  if (type.kind === "List") {
    return containsExplicitJson(type.elementType ?? unknownType);
  }
  if (type.kind === "Union") {
    return (type.options ?? []).some(containsExplicitJson);
  }
  return false;
}

export function blockstateApplyExpectationForNode(
  node: RsglBlockstateApplySiteNode
): Exclude<RsglBlockstateApplyExpectation, "modelIdOnly"> {
  return node.kind === "BlockstateRandomItem" ? "modelOrObject" : "modelOrObjectOrFlatList";
}
