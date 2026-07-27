import type {
  BlockstateModelSpecNode,
  ExprNode,
  ObjectPropertyNode,
  TextRange
} from "../parser";
import {
  blockstateModelOptionNameSet,
  blockstateModelOptionType
} from "../blockstateModelOptions";
import { blockstateModelOptionMessages } from "../diagnosticMessages";
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
  type RsglScope
} from "./types";

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
        blockstateModelOptionMessages.spreadNotAllowed,
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
        blockstateModelOptionMessages.duplicateOption(name),
        property.key.range
      ));
    }
    seen.add(name);
    if (name === "weight") {
      checkExpression(context, property.value, scope);
      context.diagnostics.push(diagnostic(
        "rsgl.blockstateWeightInvalidContext",
        blockstateModelOptionMessages.weightOutsideRandomChoice,
        property.key.range
      ));
      continue;
    }
    if (!blockstateModelOptionNameSet.has(name)) {
      checkExpression(context, property.value, scope);
      context.diagnostics.push(diagnostic(
        "rsgl.unknownBlockstateModelField",
        blockstateModelOptionMessages.unknownOption(name),
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
  const optionType = blockstateModelOptionType(name);
  const expected = optionType === "boolean" ? booleanType : numberType;
  const actual = checkExpressionForExpectedType(context, expression, scope, expected);
  checkAssignable(context, expected, actual, expression);
  if (
    optionType === "number"
    && expression.kind === "NumberLiteral"
    && !isQuarterTurn(expression.value)
  ) {
    context.diagnostics.push(diagnostic(
      "rsgl.invalidBlockstateRotation",
      blockstateModelOptionMessages.invalidRotation(name),
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

export type BlockstateModelSpecSourceRange = TextRange;
