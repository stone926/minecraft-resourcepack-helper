import {
  ResourceBodyNode,
  ResourceStatementNode,
  TextRange,
  UseDeclNode
} from "../parser";
import {
  EvaluationContext,
  evaluateExpression
} from "./evaluate";
import { applyBaseDocument } from "./base/application";
import { normalizeJsonValue } from "./compilerHelpers";
import type { FragmentMergePolicy } from "./fragmentMerge";
import { JsonValue } from "./ir";
import { isJsonObject } from "./jsonValues";
import { forEachLoopContext } from "./looping";
import {
  applyResourceBodyFragment,
  emitResourceBodyMapping as emitMapping
} from "./resourceBodyContentMerge";
import { appendGeneratedPath } from "./sourcePaths";

export interface ResourceBodyCompileOptions {
  onError?: (code: string, message: string, range: { start: number; end: number }) => void;
  onUseFragment?: (statement: UseDeclNode, context: EvaluationContext) => ResourceBodyFragment | undefined;
  onSpecialStatement?: (statement: ResourceStatementNode, context: EvaluationContext) => ResourceBodySpecialResult | undefined;
  onMapping?: (mapping: ResourceBodyMapping) => void;
  mergePolicy?: FragmentMergePolicy;
  /** Only concrete resource roots may initialize themselves from a base document. */
  allowBase?: boolean;
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
  return resourceBodyToObjectAtPath(body, context, options, "", options.allowBase ?? false);
}

function resourceBodyToObjectAtPath(
  body: ResourceBodyNode,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions,
  path: string,
  allowBase: boolean
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  body.statements.forEach((statement, index) => {
    applyResourceStatement(result, statement, context, options, path, allowBase, index === 0);
  });
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
  path: string,
  allowBase: boolean,
  isFirstStatement: boolean
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
      result[statement.name.text] = resourceBodyToObjectAtPath(statement.body, context, options, sectionPath, false);
    } else if (statement.value) {
      result[statement.name.text] = normalizeJsonValue(evaluateExpression(statement.value, context));
      emitMapping(options, appendGeneratedPath(path, statement.name.text), statement.range, context);
    }
  } else if (statement.kind === "IfStmt") {
    const selectedBody = evaluateExpression(statement.condition, context) ? statement.thenBody : statement.elseBody;
    if (selectedBody?.kind === "ResourceBody") {
      applyResourceBodyFragment(
        result,
        compileControlFlowFragment(selectedBody, context, options, path),
        "deep",
        statement.range,
        context,
        options,
        path
      );
    }
  } else if (statement.kind === "ForStmt") {
    applyForStatement(result, statement, context, options, path);
  } else if (statement.kind === "MergeStmt") {
    const value = normalizeJsonValue(evaluateExpression(statement.value, context));
    if (isJsonObject(value)) {
      applyResourceBodyFragment(
        result,
        { content: value },
        statement.mode,
        statement.range,
        context,
        options,
        path,
        true
      );
    } else {
      options.onError?.("rsgl.invalidMergeFragment", "merge must evaluate to an object fragment.", statement.value.range);
    }
  } else if (statement.kind === "UseDecl") {
    const fragment = options.onUseFragment?.(statement, context);
    if (fragment) {
      applyResourceBodyFragment(result, fragment, "deep", statement.range, context, options, path);
    }
  } else if (statement.kind === "BaseStmt") {
    const base = applyBaseDocument(statement, context, {
      allowBase,
      isRoot: path === "",
      isFirstStatement,
      onError: (code, message, range) => options.onError?.(code, message, range),
      createMapping: (generatedPath, sourceRange, mappingContext): ResourceBodyMapping => ({
        generatedPath,
        sourceRange,
        context: mappingContext
      })
    });
    if (base) {
      Object.assign(result, base.content);
      base.mappings.forEach(mapping => options.onMapping?.(mapping));
    }
  } else {
    const fragment = resourceBodyFragmentFromResult(options.onSpecialStatement?.(statement, context));
    if (fragment) {
      applyResourceBodyFragment(result, fragment, "deep", statement.range, context, options, path);
    }
  }
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

function compileControlFlowFragment(
  body: ResourceBodyNode,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions,
  path: string
): ResourceBodyFragment {
  const mappings: ResourceBodyMapping[] = [];
  const content = resourceBodyToObjectAtPath(body, context, {
    ...options,
    onMapping: mapping => mappings.push({
      ...mapping,
      generatedPath: relativeGeneratedPath(path, mapping.generatedPath)
    })
  }, path, false);
  return { content, mappings };
}

function relativeGeneratedPath(basePath: string, generatedPath: string): string {
  if (!basePath) {
    return generatedPath;
  }
  if (generatedPath === basePath) {
    return "";
  }
  return generatedPath.startsWith(`${basePath}/`)
    ? generatedPath.slice(basePath.length)
    : generatedPath;
}

function applyForStatement(
  result: Record<string, JsonValue>,
  statement: Extract<ResourceStatementNode, { kind: "ForStmt" }>,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions,
  path: string
): void {
  if (statement.body.kind !== "ResourceBody") {
    return;
  }
  const body = statement.body;
  forEachLoopContext(statement, context, (code, message, range) => options.onError?.(code, message, range), loopContext => {
    applyResourceBodyFragment(
      result,
      compileControlFlowFragment(body, loopContext, options, path),
      "deep",
      statement.range,
      loopContext,
      options,
      path
    );
  });
}
