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
import { appendJsonObject, isJsonObject, mergeJsonObject, mergeJsonObjectDeep, overrideJsonObject } from "./jsonObjectMerge";
import { createLoopBindings, createLoopContext } from "./looping";
import { appendGeneratedPath, joinGeneratedPath } from "./sourcePaths";

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
    emitMapping(options, appendGeneratedPath(path, statement.name.text), statement.range, context);
  } else if (statement.kind === "SectionStmt") {
    if (statement.body) {
      const sectionPath = appendGeneratedPath(path, statement.name.text);
      emitMapping(options, sectionPath, statement.range, context);
      result[statement.name.text] = resourceBodyToObjectAtPath(statement.body, context, options, sectionPath);
    } else if (statement.value) {
      result[statement.name.text] = normalizeJsonValue(evaluateExpression(statement.value, context));
      emitMapping(options, appendGeneratedPath(path, statement.name.text), statement.range, context);
    }
  } else if (statement.kind === "IfStmt") {
    const selectedBody = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
    if (selectedBody?.kind === "ResourceBody") {
      mergeJsonObjectDeep(result, resourceBodyToObjectAtPath(selectedBody, context, options, path));
    }
  } else if (statement.kind === "ForStmt") {
    applyForStatement(result, statement, context, options, path);
  } else if (statement.kind === "RawJsonStmt") {
    const value = normalizeJsonValue(evaluateExpression(statement.value, context));
    if (isJsonObject(value)) {
      mergeJsonObject(result, value);
      emitObjectMappings(options, path, value, statement.range, context);
    } else {
      options.onError?.("rsgl.invalidRawJsonFragment", "raw_json must evaluate to an object fragment.", statement.value.range);
    }
  } else if (statement.kind === "OverrideStmt") {
    const value = normalizeJsonValue(evaluateExpression(statement.value, context));
    if (isJsonObject(value)) {
      const applied = overrideJsonObject(result, value, statement.create, { onError: options.onError, path, range: statement.range });
      emitObjectMappings(options, path, applied, statement.range, context);
    } else {
      options.onError?.("rsgl.invalidOverrideFragment", "override must evaluate to an object fragment.", statement.value.range);
    }
  } else if (statement.kind === "AppendStmt") {
    const value = normalizeJsonValue(evaluateExpression(statement.value, context));
    if (isJsonObject(value)) {
      const applied = appendJsonObject(result, value, { onError: options.onError, path, range: statement.range });
      emitObjectMappings(options, path, applied, statement.range, context);
    } else {
      options.onError?.("rsgl.invalidAppendFragment", "append must evaluate to an object fragment.", statement.value.range);
    }
  } else if (statement.kind === "UseDecl") {
    const fragment = options.onUseFragment?.(statement, context);
    if (fragment) {
      mergeJsonObjectDeep(result, fragment.content);
      emitFragmentMappings(options, path, fragment, statement.range, context);
    }
  } else {
    const fragment = options.onSpecialStatement?.(statement, context);
    if (fragment) {
      mergeJsonObjectDeep(result, fragment);
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
    mergeJsonObjectDeep(result, resourceBodyToObjectAtPath(statement.body, loopContext, options, path));
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
    emitMapping(options, appendGeneratedPath(path, key), sourceRange, context);
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

function normalizeJsonValue(value: EvaluationValue): JsonValue {
  return value === undefined ? null : value;
}
