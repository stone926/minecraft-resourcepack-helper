import {
  ResourceBodyNode,
  ResourceStatementNode,
  TextRange,
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
  onUseFragment?: (statement: UseDeclNode, context: EvaluationContext) => ResourceBodyFragment | undefined;
  onSpecialStatement?: (statement: ResourceStatementNode, context: EvaluationContext) => Record<string, JsonValue> | undefined;
  onMapping?: (mapping: ResourceBodyMapping) => void;
}

export interface ResourceBodyFragment {
  content: Record<string, JsonValue>;
  mappings?: ResourceBodyMapping[];
}

export interface ResourceBodyMapping {
  generatedPath: string;
  sourceRange: TextRange;
  context: EvaluationContext;
}

export function resourceBodyToObject(
  body: ResourceBodyNode,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions = {}
): Record<string, JsonValue> {
  return resourceBodyToObjectAtPath(body, context, options, "");
}

function resourceBodyToObjectAtPath(
  body: ResourceBodyNode,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions,
  path: string
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const statement of body.statements) {
    applyResourceStatement(result, statement, context, options, path);
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
  options: ResourceBodyCompileOptions,
  path: string
): void {
  if (statement.kind === "PropertyStmt") {
    result[statement.name.text] = normalizeJsonValue(evaluateExpression(statement.value, context));
    emitMapping(options, appendPath(path, statement.name.text), statement.range, context);
  } else if (statement.kind === "SectionStmt") {
    if (statement.body) {
      const sectionPath = appendPath(path, statement.name.text);
      emitMapping(options, sectionPath, statement.range, context);
      result[statement.name.text] = resourceBodyToObjectAtPath(statement.body, context, options, sectionPath);
    } else if (statement.value) {
      result[statement.name.text] = normalizeJsonValue(evaluateExpression(statement.value, context));
      emitMapping(options, appendPath(path, statement.name.text), statement.range, context);
    }
  } else if (statement.kind === "IfStmt") {
    const selectedBody = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
    if (selectedBody?.kind === "ResourceBody") {
      mergeResourceObject(result, resourceBodyToObjectAtPath(selectedBody, context, options, path));
    }
  } else if (statement.kind === "ForStmt") {
    applyForStatement(result, statement, context, options, path);
  } else if (statement.kind === "RawJsonStmt" || statement.kind === "OverrideStmt") {
    const value = normalizeJsonValue(evaluateExpression(statement.value, context));
    if (isJsonObject(value)) {
      mergeObject(result, value);
      emitObjectMappings(options, path, value, statement.range, context);
    }
  } else if (statement.kind === "AppendStmt") {
    const value = normalizeJsonValue(evaluateExpression(statement.value, context));
    if (isJsonObject(value)) {
      mergeResourceObject(result, value);
      emitObjectMappings(options, path, value, statement.range, context);
    }
  } else if (statement.kind === "UseDecl") {
    const fragment = options.onUseFragment?.(statement, context);
    if (fragment) {
      mergeResourceObject(result, fragment.content);
      emitFragmentMappings(options, path, fragment, statement.range, context);
    }
  } else {
    const fragment = options.onSpecialStatement?.(statement, context);
    if (fragment) {
      mergeResourceObject(result, fragment);
      emitObjectMappings(options, path, fragment, statement.range, context);
    }
  }
}

function emitFragmentMappings(
  options: ResourceBodyCompileOptions,
  path: string,
  fragment: ResourceBodyFragment,
  fallbackRange: TextRange,
  fallbackContext: EvaluationContext
): void {
  if (fragment.mappings?.length) {
    for (const mapping of fragment.mappings) {
      emitMapping(
        options,
        joinGeneratedPath(path, mapping.generatedPath),
        mapping.sourceRange,
        mapping.context
      );
    }
    return;
  }
  emitObjectMappings(options, path, fragment.content, fallbackRange, fallbackContext);
}

function applyForStatement(
  result: Record<string, JsonValue>,
  statement: Extract<ResourceStatementNode, { kind: "ForStmt" }>,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions,
  path: string
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
    mergeResourceObject(result, resourceBodyToObjectAtPath(statement.body, loopContext, options, path));
  }
}

function emitObjectMappings(
  options: ResourceBodyCompileOptions,
  path: string,
  value: Record<string, JsonValue>,
  sourceRange: TextRange,
  context: EvaluationContext
): void {
  for (const key of Object.keys(value)) {
    emitMapping(options, appendPath(path, key), sourceRange, context);
  }
}

function emitMapping(
  options: ResourceBodyCompileOptions,
  generatedPath: string,
  sourceRange: TextRange,
  context: EvaluationContext
): void {
  options.onMapping?.({ generatedPath, sourceRange, context });
}

function appendPath(path: string, segment: string): string {
  return `${path}/${escapeJsonPointerSegment(segment)}`;
}

function joinGeneratedPath(path: string, generatedPath: string): string {
  if (!path) {
    return generatedPath;
  }
  if (!generatedPath) {
    return path;
  }
  return `${path}${generatedPath.startsWith("/") ? generatedPath : `/${generatedPath}`}`;
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function mergeObject(target: Record<string, JsonValue>, source: Record<string, JsonValue>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = value;
  }
}

function mergeResourceObject(target: Record<string, JsonValue>, source: Record<string, JsonValue>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      target[key] = [...existing, ...value];
    } else if (isJsonObject(existing) && isJsonObject(value)) {
      mergeResourceObject(existing, value);
    } else {
      target[key] = value;
    }
  }
}

function normalizeJsonValue(value: EvaluationValue): JsonValue {
  return value === undefined ? null : value;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
