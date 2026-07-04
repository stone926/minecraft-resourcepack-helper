import {
  ResourceBodyNode,
  ResourceStatementNode,
  UseDeclNode
} from "../parser";
import {
  EvaluationContext,
  EvaluationValue,
  evaluateExpression
} from "./evaluate";
import { JsonValue } from "./ir";
import { createLoopBindings, createLoopContext } from "./looping";

export interface ResourceBodyCompileOptions {
  onError?: (code: string, message: string, range: { start: number; end: number }) => void;
  onUseFragment?: (statement: UseDeclNode, context: EvaluationContext) => Record<string, JsonValue> | undefined;
}

export function resourceBodyToObject(
  body: ResourceBodyNode,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions = {}
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const statement of body.statements) {
    applyResourceStatement(result, statement, context, options);
  }
  return result;
}

export function findResourceStatement(body: ResourceBodyNode, kind: ResourceStatementNode["kind"]): ResourceStatementNode | undefined {
  return body.statements.find(statement => statement.kind === kind);
}

function applyResourceStatement(
  result: Record<string, JsonValue>,
  statement: ResourceStatementNode,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions
): void {
  if (statement.kind === "PropertyStmt") {
    result[statement.name.text] = normalizeJsonValue(evaluateExpression(statement.value, context));
  } else if (statement.kind === "SectionStmt") {
    if (statement.body) {
      result[statement.name.text] = resourceBodyToObject(statement.body, context, options);
    } else if (statement.value) {
      result[statement.name.text] = normalizeJsonValue(evaluateExpression(statement.value, context));
    }
  } else if (statement.kind === "IfStmt") {
    const selectedBody = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
    if (selectedBody?.kind === "ResourceBody") {
      mergeObject(result, resourceBodyToObject(selectedBody, context, options));
    }
  } else if (statement.kind === "ForStmt") {
    applyForStatement(result, statement, context, options);
  } else if (statement.kind === "RawJsonStmt" || statement.kind === "OverrideStmt") {
    const value = normalizeJsonValue(evaluateExpression(statement.value, context));
    if (isJsonObject(value)) {
      mergeObject(result, value);
    }
  } else if (statement.kind === "UseDecl") {
    const fragment = options.onUseFragment?.(statement, context);
    if (fragment) {
      mergeObject(result, fragment);
    }
  }
}

function applyForStatement(
  result: Record<string, JsonValue>,
  statement: Extract<ResourceStatementNode, { kind: "ForStmt" }>,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions
): void {
  const iterable = evaluateExpression(statement.iterable, context);
  if (!Array.isArray(iterable)) {
    options.onError?.("rsgl.compileNonFiniteLoop", "for input must evaluate to a finite list.", statement.iterable.range);
    return;
  }
  if (statement.body.kind !== "ResourceBody") {
    return;
  }
  for (const value of iterable) {
    const bindings = createLoopBindings(statement.bindings.map(binding => binding.text), value);
    const loopContext = createLoopContext(context, bindings, statement.range);
    mergeObject(result, resourceBodyToObject(statement.body, loopContext, options));
  }
}

function mergeObject(target: Record<string, JsonValue>, source: Record<string, JsonValue>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = value;
  }
}

function normalizeJsonValue(value: EvaluationValue): JsonValue {
  return value === undefined ? null : value;
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
