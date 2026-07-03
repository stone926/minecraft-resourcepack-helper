import {
  ExprNode,
  ObjectPropertyNode,
  ResourceBodyNode,
  ResourceStatementNode
} from "../parser";
import { JsonValue } from "./ir";

export type EvaluationValue = JsonValue | undefined;

export interface EvaluationContext {
  namespace: string;
  variables: Map<string, EvaluationValue>;
}

export function evaluateExpression(expression: ExprNode, context: EvaluationContext): EvaluationValue {
  if (expression.kind === "StringLiteral") {
    return expression.value;
  }
  if (expression.kind === "NumberLiteral") {
    return expression.value;
  }
  if (expression.kind === "BooleanLiteral") {
    return expression.value;
  }
  if (expression.kind === "NullLiteral") {
    return null;
  }
  if (expression.kind === "ResourceLocationExpr") {
    return expression.value.includes(":") ? expression.value : `${context.namespace}:${expression.value}`;
  }
  if (expression.kind === "IdentifierExpr") {
    return context.variables.get(expression.name.text) ?? expression.name.text;
  }
  if (expression.kind === "TemplateStringExpr") {
    return expression.parts.map(part => {
      if (part.kind === "text") {
        return part.text;
      }
      return String(evaluateExpression(part.expression, context) ?? "");
    }).join("");
  }
  if (expression.kind === "ListExpr") {
    return expression.elements.map(element => normalizeJsonValue(evaluateExpression(element, context)));
  }
  if (expression.kind === "ObjectExpr") {
    return evaluateObjectProperties(expression.properties, context);
  }
  if (expression.kind === "StateKeySugar") {
    return evaluateObjectProperties(expression.entries, context);
  }
  if (expression.kind === "ModelApplySugar") {
    const model = normalizeJsonValue(evaluateExpression(expression.model, context));
    const result: Record<string, JsonValue> = { model };
    for (const property of expression.properties) {
      result[property.name.text] = normalizeJsonValue(evaluateExpression(property.value, context));
    }
    return omitBlockstateModelDefaults(result);
  }
  if (expression.kind === "RandomApply") {
    return expression.entries.map(entry => normalizeJsonValue(evaluateExpression(entry, context)));
  }
  if (expression.kind === "RangeExpr") {
    const start = Number(evaluateExpression(expression.startExpr, context));
    const end = Number(evaluateExpression(expression.endExpr, context));
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return [];
    }
    const values: number[] = [];
    const step = start <= end ? 1 : -1;
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
      values.push(value);
    }
    return values;
  }
  if (expression.kind === "ConditionalExpr") {
    return evaluateExpression(truthy(evaluateExpression(expression.condition, context)) ? expression.whenTrue : expression.whenFalse, context);
  }
  if (expression.kind === "BinaryExpr") {
    return evaluateBinaryExpression(expression.operator, evaluateExpression(expression.left, context), evaluateExpression(expression.right, context));
  }
  if (expression.kind === "UnaryExpr") {
    const value = evaluateExpression(expression.operand, context);
    return expression.operator === "!" ? !truthy(value) : -Number(value);
  }
  return undefined;
}

export function resourceBodyToObject(body: ResourceBodyNode, context: EvaluationContext): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const statement of body.statements) {
    if (statement.kind === "PropertyStmt") {
      result[statement.name.text] = normalizeJsonValue(evaluateExpression(statement.value, context));
    } else if (statement.kind === "SectionStmt") {
      if (statement.body) {
        result[statement.name.text] = resourceBodyToObject(statement.body, context);
      } else if (statement.value) {
        result[statement.name.text] = normalizeJsonValue(evaluateExpression(statement.value, context));
      }
    }
  }
  return result;
}

export function findResourceStatement(body: ResourceBodyNode, kind: ResourceStatementNode["kind"]): ResourceStatementNode | undefined {
  return body.statements.find(statement => statement.kind === kind);
}

function evaluateObjectProperties(properties: ObjectPropertyNode[], context: EvaluationContext): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const property of properties) {
    const key = propertyKeyToString(property, context);
    if (key) {
      result[key] = normalizeJsonValue(evaluateExpression(property.value, context));
    }
  }
  return result;
}

function propertyKeyToString(property: ObjectPropertyNode, context: EvaluationContext): string | null {
  if (property.key.kind === "Identifier") {
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  const value = evaluateExpression(property.key.expression, context);
  return value === undefined ? null : String(value);
}

function normalizeJsonValue(value: EvaluationValue): JsonValue {
  return value === undefined ? null : value;
}

function evaluateBinaryExpression(operator: string, left: EvaluationValue, right: EvaluationValue): EvaluationValue {
  if (operator === "+") {
    return typeof left === "string" || typeof right === "string" ? `${left ?? ""}${right ?? ""}` : Number(left) + Number(right);
  }
  if (operator === "-") {
    return Number(left) - Number(right);
  }
  if (operator === "*") {
    return Number(left) * Number(right);
  }
  if (operator === "/") {
    return Number(left) / Number(right);
  }
  if (operator === "%") {
    return Number(left) % Number(right);
  }
  if (operator === "==") {
    return left === right;
  }
  if (operator === "!=") {
    return left !== right;
  }
  if (operator === "&&") {
    return truthy(left) && truthy(right);
  }
  if (operator === "||") {
    return truthy(left) || truthy(right);
  }
  return undefined;
}

function truthy(value: EvaluationValue): boolean {
  return Boolean(value);
}

function omitBlockstateModelDefaults(model: Record<string, JsonValue>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(model)) {
    if ((key === "x" || key === "y" || key === "z") && value === 0) {
      continue;
    }
    if (key === "uvlock" && value === false) {
      continue;
    }
    if (key === "weight" && value === 1) {
      continue;
    }
    result[key] = value;
  }
  return result;
}
