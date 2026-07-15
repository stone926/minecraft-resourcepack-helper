import type {
  BlockstateResourceDeclNode,
  TextRange,
  UseDeclNode
} from "../parser";
import type {
  RsglTemplateCallerContext,
  TemplateOutputDispatch
} from "../templateOutput";
import {
  BlockstateOperationExecutor,
  type BlockstateOperationExecutorHost
} from "./blockstateOperationExecutor";
import type { JsonValueSinkOptions } from "./jsonValueLowerer";
import {
  canonicalBlockstateOperationProgram
} from "./blockstateOperations";
import type { RsglTemplateDefinition } from "./environment";
import type { ResourceUnit, RsglMapping } from "./ir";
import { staticText } from "./compilerHelpers";
import { parseResourceId, resourceOutputPath } from "./resourceIds";
import type { RsglCompileContext, TemplateExpansion } from "./templateExpansion";

export interface BlockstateCompileOptions extends JsonValueSinkOptions {
  onError: NonNullable<JsonValueSinkOptions["onError"]>;
  resolveTemplate: (
    statement: UseDeclNode,
    context: RsglCompileContext
  ) => RsglTemplateDefinition | undefined;
  expandUse: (
    statement: UseDeclNode,
    context: RsglCompileContext,
    definition: RsglTemplateDefinition
  ) => TemplateExpansion | undefined;
  resolveTemplateDispatch: (
    definition: RsglTemplateDefinition,
    callerContext: RsglTemplateCallerContext
  ) => TemplateOutputDispatch;
  sourceMap: (
    outputPath: string,
    node: { range: TextRange },
    context: RsglCompileContext,
    mappings: RsglMapping[]
  ) => ResourceUnit["sourceMap"];
  sourceMapping: (
    generatedPath: string,
    sourceRange: TextRange,
    context: RsglCompileContext
  ) => RsglMapping;
}

export function compileBlockstateResource(
  statement: BlockstateResourceDeclNode,
  context: RsglCompileContext,
  options: BlockstateCompileOptions
): ResourceUnit | null {
  const idValue = staticText(statement.id, context);
  const id = idValue ? parseResourceId(idValue, context.namespace) : null;
  if (!id) {
    options.onError(
      "rsgl.compileMissingResourceId",
      "Blockstate declaration requires a static id.",
      statement.range,
      context.sourceFile
    );
    return null;
  }

  const executor = new BlockstateOperationExecutor(executorHost(options));
  const program = canonicalBlockstateOperationProgram(statement.body);
  const finalizeOrigin = { sourceRange: statement.modeNode.range, context };
  const body = executor.executeRoot(program, context, {
    declaredMode: statement.mode,
    finalizeOrigin,
    finalizeSelectedMode: true
  });
  const outputPath = resourceOutputPath("blockstate", id);
  return {
    id,
    kind: "blockstate",
    outputPath,
    content: body.content,
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: options.sourceMap(outputPath, statement, context, body.mappings)
  };
}

function executorHost(options: BlockstateCompileOptions): BlockstateOperationExecutorHost {
  return {
    resolveTemplate: options.resolveTemplate,
    expandUse: options.expandUse,
    resolveTemplateDispatch: options.resolveTemplateDispatch,
    onError: options.onError,
    ...(options.jsonValueAdapters
      ? { jsonValueAdapters: options.jsonValueAdapters }
      : {}),
    ...(options.onResourceValueObservation
      ? { onResourceValueObservation: options.onResourceValueObservation }
      : {}),
    sourceMapping: options.sourceMapping
  };
}
