import type {
  BlockstateModelSpecNode,
  ExprNode,
  ObjectPropertyNode,
  TextRange
} from "../parser";
import { diagnostic } from "./diagnostics";
import {
  checkAssignable,
  checkExpression,
  checkExpressionForExpectedType
} from "./expressionChecker";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import {
  booleanType,
  modelIdType,
  numberType,
  type RsglScope,
  type RsglType
} from "./types";

const modelOptionNames = new Set(["x", "y", "z", "uvlock"]);

export function checkBlockstateModelSpec(
  context: RsglExpressionCheckContext,
  modelSpec: BlockstateModelSpecNode,
  scope: RsglScope
): void {
  const actualModelType = checkExpressionForExpectedType(
    context,
    modelSpec.model,
    scope,
    modelIdType
  );
  checkAssignable(context, modelIdType, actualModelType, modelSpec.model);

  if (!modelSpec.options) {
    return;
  }
  const seen = new Set<string>();
  for (const property of modelSpec.options.properties) {
    if (property.kind === "ObjectSpread") {
      checkExpression(context, property.expression, scope);
      context.diagnostics.push(diagnostic(
        "rsgl.invalidBlockstateModelOptionsSpread",
        "A blockstate 'with' block only accepts explicit x, y, z, and uvlock fields.",
        property.range
      ));
      continue;
    }
    const name = staticPropertyName(property);
    if (name === undefined) {
      if (property.key.kind === "DynamicKey") {
        checkExpression(context, property.key.expression, scope);
      }
      checkExpression(context, property.value, scope);
      context.diagnostics.push(diagnostic(
        "rsgl.invalidBlockstateModelOption",
        "Computed fields are not allowed in a blockstate 'with' block.",
        property.key.range
      ));
      continue;
    }
    if (seen.has(name)) {
      context.diagnostics.push(diagnostic(
        "rsgl.duplicateBlockstateModelField",
        `Blockstate model option '${name}' is specified more than once.`,
        property.key.range
      ));
    }
    seen.add(name);
    if (name === "weight") {
      checkExpression(context, property.value, scope);
      context.diagnostics.push(diagnostic(
        "rsgl.blockstateWeightInvalidContext",
        "weight is only valid after an option inside a random choice.",
        property.key.range
      ));
      continue;
    }
    if (!modelOptionNames.has(name)) {
      checkExpression(context, property.value, scope);
      context.diagnostics.push(diagnostic(
        "rsgl.unknownBlockstateModelField",
        `Unknown blockstate model option '${name}'.`,
        property.key.range
      ));
      continue;
    }
    checkModelOption(context, name, property.value, scope);
  }
}

export function checkBlockstateRandomWeight(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): void {
  const actual = checkExpressionForExpectedType(context, expression, scope, numberType);
  checkAssignable(context, numberType, actual, expression);
  if (expression.kind === "NumberLiteral" && !isPositiveInteger(expression.value)) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidRandomWeight",
      "Random option weight must be a positive integer.",
      expression.range
    ));
  }
}

function checkModelOption(
  context: RsglExpressionCheckContext,
  name: string,
  expression: ExprNode,
  scope: RsglScope
): void {
  const expected = name === "uvlock" ? booleanType : numberType;
  const actual = checkExpressionForExpectedType(context, expression, scope, expected);
  checkAssignable(context, expected, actual, expression);
  if (
    name !== "uvlock"
    && expression.kind === "NumberLiteral"
    && !isQuarterTurn(expression.value)
  ) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidBlockstateRotation",
      `Blockstate model ${name} rotation must be one of 0, 90, 180, or 270.`,
      expression.range
    ));
  }
}

function staticPropertyName(property: ObjectPropertyNode): string | undefined {
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

function isQuarterTurn(value: number): boolean {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export const blockstateModelOptionNames = modelOptionNames;

export function blockstateModelOptionExpectedType(name: string): RsglType | undefined {
  if (name === "uvlock") {
    return booleanType;
  }
  return name === "x" || name === "y" || name === "z" ? numberType : undefined;
}

export type BlockstateModelSpecSourceRange = TextRange;
