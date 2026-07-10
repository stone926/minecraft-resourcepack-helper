import type { ExprNode, TextRange } from "../../parser";
import { evaluateExpression, type EvaluationContext } from "../evaluate";
import { isJsonObject } from "../jsonValues";
import { resolveBaseDocumentPath } from "./loader";
import {
  BaseDocumentLoadError,
  type BaseDocument,
  type BaseDocumentLoader,
  type CompileDependency
} from "./types";

export interface BaseStatementLike {
  path: ExprNode;
  range: TextRange;
}

export interface CompileBaseStatementOptions {
  loader?: BaseDocumentLoader;
  fallbackFileName?: string;
  onDependency?: (dependency: CompileDependency) => void;
  onError?: (code: string, message: string, range: TextRange) => void;
}

/** Evaluates and loads a first-class `base` statement. */
export function compileBaseStatement(
  statement: BaseStatementLike,
  context: EvaluationContext,
  options: CompileBaseStatementOptions = {}
): BaseDocument | undefined {
  const value = evaluateExpression(statement.path, context);
  if (typeof value !== "string") {
    reportError(
      context,
      options,
      "rsgl.basePathMustBeStaticString",
      "base path must evaluate to a static string.",
      statement.path.range
    );
    return undefined;
  }
  if (!value.trim()) {
    reportError(
      context,
      options,
      "rsgl.baseInvalidPath",
      "base path must not be empty.",
      statement.path.range
    );
    return undefined;
  }

  const sourceFile = context.sourceFile ?? options.fallbackFileName ?? "<anonymous>";
  const resolvedPath = resolveBaseDocumentPath(value, context.sourceFile, options.fallbackFileName);
  const dependency: CompileDependency = {
    path: resolvedPath,
    reason: "base-import",
    sourceFile,
    sourceRange: statement.range
  };
  emitDependency(context, options, dependency);

  const loader = options.loader ?? context.baseDocumentLoader;
  if (!loader) {
    reportError(
      context,
      options,
      "rsgl.baseLoadFailed",
      `Unable to load base JSON '${value}': no base document loader is configured.`,
      statement.path.range
    );
    return undefined;
  }

  let document: BaseDocument;
  try {
    document = loader.load(resolvedPath, sourceFile, statement.range);
  } catch (error) {
    const code = error instanceof BaseDocumentLoadError ? error.code : "rsgl.baseLoadFailed";
    const message = error instanceof Error
      ? error.message
      : `Unable to load base JSON '${value}': ${String(error)}.`;
    reportError(context, options, code, message, statement.path.range);
    return undefined;
  }

  for (const nestedDependency of document.dependencies) {
    emitDependency(context, options, nestedDependency);
  }
  if (!isJsonObject(document.content)) {
    reportError(
      context,
      options,
      "rsgl.baseMustBeObject",
      "base JSON must contain an object at its root.",
      statement.path.range
    );
    return undefined;
  }
  return document;
}

function emitDependency(
  context: EvaluationContext,
  options: CompileBaseStatementOptions,
  dependency: CompileDependency
): void {
  (options.onDependency ?? context.onDependency)?.(dependency);
}

function reportError(
  context: EvaluationContext,
  options: CompileBaseStatementOptions,
  code: string,
  message: string,
  range: TextRange
): void {
  if (options.onError) {
    options.onError(code, message, range);
  } else {
    context.onError?.(code, message, range, context.sourceFile);
  }
}
