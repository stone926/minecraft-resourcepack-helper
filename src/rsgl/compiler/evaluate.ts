import {
  ExprNode,
  ObjectPropertyNode
} from "../parser";
import { ExpansionFrame, JsonValue, RsglMapping } from "./ir";

export type EvaluationValue = JsonValue | undefined;

export interface EvaluationContext {
  namespace: string;
  variables: Map<string, EvaluationValue>;
  sourceFile?: string;
  mappingReason?: RsglMapping["reason"];
  expansionStack?: ExpansionFrame[];
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
  if (expression.kind === "CallExpr") {
    return evaluateCallExpression(expression.callee, expression.args.map(arg => ({
      name: arg.name?.text,
      value: evaluateExpression(arg.value, context)
    })), context);
  }
  if (expression.kind === "MemberExpr") {
    const objectValue = evaluateExpression(expression.object, context);
    if (objectValue && typeof objectValue === "object" && !Array.isArray(objectValue)) {
      return objectValue[expression.property.text] as EvaluationValue;
    }
    return undefined;
  }
  if (expression.kind === "IndexExpr") {
    const objectValue = evaluateExpression(expression.object, context);
    const indexValue = evaluateExpression(expression.index, context);
    if (Array.isArray(objectValue) && typeof indexValue === "number") {
      return objectValue[indexValue] as EvaluationValue;
    }
    if (objectValue && typeof objectValue === "object" && !Array.isArray(objectValue)) {
      return objectValue[String(indexValue)] as EvaluationValue;
    }
    return undefined;
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

export function childEvaluationContext(
  context: EvaluationContext,
  values: Record<string, EvaluationValue>,
  metadata: Partial<Pick<EvaluationContext, "sourceFile" | "mappingReason" | "expansionStack">> = {}
): EvaluationContext {
  return {
    namespace: context.namespace,
    variables: new Map([...context.variables, ...Object.entries(values)]),
    sourceFile: metadata.sourceFile ?? context.sourceFile,
    mappingReason: metadata.mappingReason ?? context.mappingReason,
    expansionStack: metadata.expansionStack ?? context.expansionStack
  };
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

function evaluateCallExpression(
  callee: ExprNode,
  args: Array<{ name?: string; value: EvaluationValue }>,
  context: EvaluationContext
): EvaluationValue {
  if (callee.kind !== "IdentifierExpr") {
    return undefined;
  }

  if (callee.name.text === "product") {
    const source = normalizeJsonValue(args[0]?.value);
    return source && typeof source === "object" && !Array.isArray(source) ? product(source as Record<string, JsonValue>) : [];
  }
  if (callee.name.text === "pad") {
    const value = String(args[0]?.value ?? "");
    const width = Number(args[1]?.value ?? 0);
    return value.padStart(width, "0");
  }
  if (callee.name.text === "seq") {
    const pattern = String(args[0]?.value ?? "");
    return expandSequence(pattern, context);
  }

  return undefined;
}

function product(source: Record<string, JsonValue>): JsonValue[] {
  const entries = Object.entries(source).map(([key, value]) => ({
    key,
    values: Array.isArray(value) ? value : [value]
  }));
  let results: Record<string, JsonValue>[] = [{}];
  for (const entry of entries) {
    const next: Record<string, JsonValue>[] = [];
    for (const result of results) {
      for (const value of entry.values) {
        next.push({ ...result, [entry.key]: value });
      }
    }
    results = next;
  }
  return results;
}

function expandSequence(pattern: string, context: EvaluationContext): string[] {
  const match = /\{(-?\d+)\.\.(-?\d+)\}/.exec(pattern);
  if (!match) {
    return [pattern];
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const width = match[1].startsWith("0") || match[2].startsWith("0") ? Math.max(match[1].length, match[2].length) : 0;
  const values = evaluateExpression({
    kind: "RangeExpr",
    startExpr: { kind: "NumberLiteral", value: start, raw: String(start), range: { start: 0, end: 0 }, fullRange: { start: 0, end: 0 } },
    endExpr: { kind: "NumberLiteral", value: end, raw: String(end), range: { start: 0, end: 0 }, fullRange: { start: 0, end: 0 } },
    inclusive: true,
    range: { start: 0, end: 0 },
    fullRange: { start: 0, end: 0 }
  }, context);
  return Array.isArray(values)
    ? values.map(value => pattern.replace(match[0], String(value).padStart(width, "0")))
    : [pattern];
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
