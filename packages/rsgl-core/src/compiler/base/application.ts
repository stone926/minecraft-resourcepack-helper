import type { ResourceStatementNode, TextRange } from "../../parser";
import type { EvaluationContext } from "../evaluate";
import type { JsonValue } from "../ir";
import { cloneJsonObject, isJsonObject } from "../jsonValues";
import { compileBaseStatement } from "./statement";

type BaseStatementNode = Extract<ResourceStatementNode, { kind: "BaseStmt" }>;

export interface BaseApplicationOptions<TContext extends EvaluationContext, TMapping> {
  allowBase: boolean;
  isRoot: boolean;
  isFirstStatement: boolean;
  onError: (code: string, message: string, range: TextRange) => void;
  createMapping: (generatedPath: string, sourceRange: TextRange, context: TContext) => TMapping;
}

export interface BaseApplicationResult<TMapping> {
  content: Record<string, JsonValue>;
  mappings: TMapping[];
}

/** Validates and materializes a root `base` statement for any resource-body compiler. */
export function applyBaseDocument<TContext extends EvaluationContext, TMapping>(
  statement: BaseStatementNode,
  context: TContext,
  options: BaseApplicationOptions<TContext, TMapping>
): BaseApplicationResult<TMapping> | undefined {
  if (!options.allowBase || !options.isRoot) {
    options.onError(
      "rsgl.baseInvalidContext",
      "base is only valid as the first direct statement of a concrete resource body.",
      statement.range
    );
    return undefined;
  }
  if (!options.isFirstStatement) {
    options.onError(
      "rsgl.baseMustPrecedeBody",
      "base must precede all other resource body statements.",
      statement.range
    );
    return undefined;
  }

  const document = compileBaseStatement(statement, context);
  if (!document || !isJsonObject(document.content)) {
    return undefined;
  }

  const mappings = [options.createMapping("", statement.range, context)];
  const baseContext = {
    ...context,
    sourceFile: document.sourceFile,
    mappingReason: "base" as const
  } as TContext;
  for (const [generatedPath, sourceRange] of document.sourceRanges) {
    if (generatedPath) {
      mappings.push(options.createMapping(generatedPath, sourceRange, baseContext));
    }
  }
  return {
    content: cloneJsonObject(document.content),
    mappings
  };
}
