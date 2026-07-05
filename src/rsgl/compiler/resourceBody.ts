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
  onSpecialStatement?: (statement: ResourceStatementNode, context: EvaluationContext) => ResourceBodySpecialResult | undefined;
  onMapping?: (mapping: ResourceBodyMapping) => void;
}

export type ResourceBodySpecialResult = ResourceBodyFragment | Record<string, JsonValue>;

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
  } else if (statement.kind === "LetDecl") {
    if (statement.name) {
      context.variables.set(statement.name.text, evaluateExpression(statement.value, context));
    }
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
      emitObjectMappingsDeep(options, path, value, statement.range, context);
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
      const mappings = mergeFragmentContent(result, fragment);
      emitFragmentMappings(options, path, { ...fragment, mappings }, statement.range, context);
    }
  } else {
    const fragment = resourceBodyFragmentFromResult(options.onSpecialStatement?.(statement, context));
    if (fragment) {
      const mappings = mergeFragmentContent(result, fragment);
      emitFragmentMappings(options, path, { ...fragment, mappings }, statement.range, context);
    }
  }
}

function mergeFragmentContent(
  result: Record<string, JsonValue>,
  fragment: ResourceBodyFragment
): ResourceBodyMapping[] | undefined {
  const mappings = offsetFragmentMappingsForMerge(result, fragment);
  mergeJsonObjectDeep(result, fragment.content);
  return mappings;
}

function resourceBodyFragmentFromResult(result: ResourceBodySpecialResult | undefined): ResourceBodyFragment | undefined {
  if (!result) {
    return undefined;
  }
  if (isResourceBodyFragment(result)) {
    return result;
  }
  return { content: result };
}

function isResourceBodyFragment(value: ResourceBodySpecialResult): value is ResourceBodyFragment {
  const candidate = value as Partial<ResourceBodyFragment>;
  return isJsonObject(candidate.content) && Array.isArray(candidate.mappings);
}

function offsetFragmentMappingsForMerge(
  result: Record<string, JsonValue>,
  fragment: ResourceBodyFragment
): ResourceBodyMapping[] | undefined {
  if (!fragment.mappings?.length) {
    return fragment.mappings;
  }
  const offsets = fragmentArrayOffsets(result, fragment.content);
  if (offsets.size === 0) {
    return fragment.mappings;
  }
  return fragment.mappings.map(mapping => ({
    ...mapping,
    generatedPath: offsetFragmentMappingPath(mapping.generatedPath, offsets)
  }));
}

function fragmentArrayOffsets(
  result: Record<string, JsonValue>,
  content: Record<string, JsonValue>
): Map<string, number> {
  const offsets = new Map<string, number>();
  collectFragmentArrayOffsets(result, content, "", offsets);
  return offsets;
}

function collectFragmentArrayOffsets(
  existing: JsonValue | undefined,
  incoming: JsonValue | undefined,
  path: string,
  offsets: Map<string, number>
): void {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    if (existing.length > 0) {
      offsets.set(path, existing.length);
    }
    return;
  }
  if (!isJsonObject(existing) || !isJsonObject(incoming)) {
    return;
  }
  for (const [key, value] of Object.entries(incoming)) {
    collectFragmentArrayOffsets(existing[key], value, appendGeneratedPath(path, key), offsets);
  }
}

function offsetFragmentMappingPath(generatedPath: string, offsets: Map<string, number>): string {
  const paths = Array.from(offsets.keys()).sort((left, right) => right.length - left.length);
  for (const path of paths) {
    const offset = offsets.get(path);
    if (!offset || !generatedPath.startsWith(`${path}/`)) {
      continue;
    }
    const rest = generatedPath.slice(path.length + 1);
    const match = /^(\d+)(\/.*)?$/.exec(rest);
    if (match) {
      return `${path}/${Number(match[1]) + offset}${match[2] ?? ""}`;
    }
  }
  return generatedPath;
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

function emitObjectMappingsDeep(
  options: ResourceBodyCompileOptions,
  path: string,
  value: Record<string, JsonValue>,
  sourceRange: TextRange,
  context: EvaluationContext
): void {
  for (const [key, item] of Object.entries(value)) {
    emitValueMappingsDeep(options, appendGeneratedPath(path, key), item, sourceRange, context);
  }
}

function emitValueMappingsDeep(
  options: ResourceBodyCompileOptions,
  path: string,
  value: JsonValue,
  sourceRange: TextRange,
  context: EvaluationContext
): void {
  emitMapping(options, path, sourceRange, context);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      emitValueMappingsDeep(options, appendGeneratedPath(path, String(index)), item, sourceRange, context);
    });
    return;
  }
  if (isJsonObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      emitValueMappingsDeep(options, appendGeneratedPath(path, key), item, sourceRange, context);
    }
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
