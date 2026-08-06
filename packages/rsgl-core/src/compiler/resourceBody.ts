import { resourceBodyMessages } from "../diagnosticMessages";
import {
  ExprNode,
  PropertyStmtNode,
  ResourceBodyNode,
  ResourceStatementNode,
  TextRange,
  UseDeclNode
} from "../parser";
import {
  EvaluationContext,
  type EvaluationOrigin,
  bindEvaluationResult,
  childEvaluationContext,
  evaluateCompileTimeCondition,
  evaluateExpression,
  evaluateExpressionResult
} from "./evaluate";
import { applyBaseDocument } from "./base/application";
import type { FragmentMergePolicy } from "./fragmentMerge";
import { JsonValue } from "./ir";
import {
  createJsonObject,
  jsonObjectEntries,
  setJsonObjectProperty
} from "./jsonObjectProperties";
import { isJsonObject } from "./jsonValues";
import {
  evaluateJsonExpressionWithResult,
  type EvaluatedJsonExpression,
  type JsonValueSinkOptions
} from "./jsonValueLowerer";
import { forEachLoopContext } from "./looping";
import {
  applyResourceBodyFragment,
  emitResourceBodyMapping as emitMapping
} from "./resourceBodyContentMerge";
import { appendGeneratedPath, joinGeneratedPath } from "./sourcePaths";
import { evaluatePropertyKey } from "./propertyKeyEvaluation";

export interface ResourceBodyCompileOptions extends JsonValueSinkOptions {
  onUseFragment?: (statement: UseDeclNode, context: EvaluationContext) => ResourceBodyFragment | undefined;
  onSpecialStatement?: (statement: ResourceStatementNode, context: EvaluationContext) => ResourceBodySpecialResult | undefined;
  onMapping?: (mapping: ResourceBodyMapping) => void;
  mergePolicy?: FragmentMergePolicy;
  /** Only concrete resource roots may initialize themselves from a base document. */
  allowBase?: boolean;
  /** Final JSON location when this body is compiled as a nested resource fragment. */
  generatedPathPrefix?: string;
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
  validationOrigin?: EvaluationOrigin;
  validationOnly?: boolean;
}

export function resourceBodyToObject(
  body: ResourceBodyNode,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions = {}
): Record<string, JsonValue> {
  return resourceBodyToObjectAtPath(
    body,
    context,
    options,
    options.generatedPathPrefix ?? "",
    options.allowBase ?? false
  );
}

function resourceBodyToObjectAtPath(
  body: ResourceBodyNode,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions,
  path: string,
  allowBase: boolean
): Record<string, JsonValue> {
  const result = createJsonObject();
  body.statements.forEach((statement, index) => {
    applyResourceBodyStatement(result, statement, context, options, path, allowBase, index === 0);
  });
  return result;
}

export function findResourceStatement(body: ResourceBodyNode, kind: ResourceStatementNode["kind"]): ResourceStatementNode | undefined {
  return body.statements.find(statement => statement.kind === kind);
}

/**
 * Applies one statement with the canonical generic resource-body semantics.
 *
 * Specialized ordered executors (for example item roots) use this seam for
 * ordinary properties, sections, base documents, and explicit merge modes
 * while retaining control over their domain-specific operations.
 */
export function applyResourceBodyStatement(
  result: Record<string, JsonValue>,
  statement: ResourceStatementNode,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions,
  path: string,
  allowBase: boolean,
  isFirstStatement: boolean
): void {
  if (statement.kind === "PropertyStmt") {
    const key = resolveResourceBodyPropertyKey(statement, context, options);
    if (key !== null) {
      applyResolvedResourceBodyProperty(result, statement, key, context, options, path);
    }
  } else if (statement.kind === "LetDecl") {
    if (statement.name) {
      bindEvaluationResult(
        context,
        statement.name.text,
        evaluateExpressionResult(statement.value, context)
      );
    }
  } else if (statement.kind === "SectionStmt") {
    if (statement.body) {
      const sectionPath = appendGeneratedPath(path, statement.name.text);
      const sectionContext = childEvaluationContext(context, {});
      emitMapping(options, sectionPath, statement.range, context);
      setJsonObjectProperty(
        result,
        statement.name.text,
        resourceBodyToObjectAtPath(statement.body, sectionContext, options, sectionPath, false)
      );
    } else if (statement.value) {
      const generatedPath = appendGeneratedPath(path, statement.name.text);
      const evaluated = evaluateJsonExpressionWithResult(statement.value, context, options, generatedPath);
      if (evaluated) {
        setJsonObjectProperty(result, statement.name.text, evaluated.value);
        emitExpressionMapping(
          options,
          generatedPath,
          statement.value,
          evaluated,
          statement.range,
          context
        );
      }
    }
  } else if (statement.kind === "IfStmt") {
    const condition = evaluateCompileTimeCondition(statement.condition, context);
    if (condition === undefined) {
      return;
    }
    const selectedBody = condition ? statement.thenBody : statement.elseBody;
    if (selectedBody?.kind === "ResourceBody") {
      const branchContext = childEvaluationContext(context, {});
      applyResourceBodyFragment(
        result,
        compileControlFlowFragment(selectedBody, branchContext, options, path),
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
    const evaluated = evaluateJsonExpressionWithResult(statement.value, context, options, path);
    if (!evaluated) {
      return;
    }
    const value = evaluated.value;
    if (isJsonObject(value)) {
      const validationMappings: ResourceBodyMapping[] = evaluated.result.pathOrigins.map(origin => ({
        generatedPath: origin.generatedPath,
        sourceRange: statement.value.range,
        context,
        validationOrigin: origin,
        validationOnly: true
      }));
      applyResourceBodyFragment(
        result,
        { content: value, mappings: validationMappings },
        statement.mode,
        statement.range,
        context,
        options,
        path,
        true
      );
    } else {
      options.onError?.("rsgl.invalidMergeFragment", resourceBodyMessages.mergeMustBeObjectFragment, statement.value.range);
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
      for (const [key, value] of jsonObjectEntries(base.content)) {
        setJsonObjectProperty(result, key, value);
      }
      base.mappings.forEach(mapping => options.onMapping?.(mapping));
    }
  } else {
    const fragment = resourceBodyFragmentFromResult(options.onSpecialStatement?.(statement, context));
    if (fragment) {
      applyResourceBodyFragment(result, fragment, "deep", statement.range, context, options, path);
    }
  }
}

/** Evaluates one resource property key once and reports a targeted failure. */
export function resolveResourceBodyPropertyKey(
  statement: PropertyStmtNode,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions
): string | null {
  const key = evaluatePropertyKey(statement.key, context, { evaluateExpression });
  if (key !== null) {
    return key;
  }
  context.onEvaluationFailure?.();
  options.onInvalidJsonValue?.();
  options.onError?.(
    "rsgl.invalidPropertyKey",
    "A computed property key must evaluate to a string, number, or boolean scalar value.",
    statement.key.kind === "DynamicKey" ? statement.key.expression.range : statement.key.range,
    context.sourceFile
  );
  return null;
}

/** Applies a property whose key has already been evaluated by an ordered executor. */
export function applyResolvedResourceBodyProperty(
  result: Record<string, JsonValue>,
  statement: PropertyStmtNode,
  key: string,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions,
  path: string
): void {
  const generatedPath = appendGeneratedPath(path, key);
  const evaluated = evaluateJsonExpressionWithResult(statement.value, context, options, generatedPath);
  if (!evaluated) {
    return;
  }
  setJsonObjectProperty(result, key, evaluated.value);
  emitExpressionMapping(
    options,
    generatedPath,
    statement.value,
    evaluated,
    statement.range,
    context
  );
}

function emitExpressionMapping(
  options: ResourceBodyCompileOptions,
  generatedPath: string,
  expression: ExprNode,
  evaluated: EvaluatedJsonExpression,
  fallbackRange: TextRange,
  context: EvaluationContext
): void {
  emitMapping(options, generatedPath, fallbackRange, context);
  const origins = expression.kind === "CallExpr"
    && expression.callee.kind === "IdentifierExpr"
    && expression.callee.name.text === "seq"
    ? evaluated.result.pathOrigins.filter(origin => origin.generatedPath !== "")
    : evaluated.result.pathOrigins;
  for (const origin of origins) {
    emitMapping(
      options,
      joinGeneratedPath(generatedPath, origin.generatedPath),
      fallbackRange,
      context,
      origin,
      true
    );
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
