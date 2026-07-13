import type {
  ResourceDeclNode,
  TextRange,
  UseDeclNode
} from "../parser";
import type {
  RsglTemplateCallerContext,
  TemplateOutputDispatch
} from "../templateOutput";
import type {
  RsglBlockstateApplyFact,
  RsglBlockstateApplySiteNode
} from "../semantic";
import {
  BlockstateOperationExecutor,
  type BlockstateOperationExecutorHost
} from "./blockstateOperationExecutor";
import type { BlockstateJsonValueLoweringHost } from "./blockstateJsonValueLowerer";
import {
  canonicalBlockstateOperationProgram,
  legacyBlockstateOperationProgram
} from "./blockstateOperations";
import type { RsglTemplateDefinition } from "./environment";
import type { ResourceUnit, RsglMapping } from "./ir";
import { staticText } from "./compilerHelpers";
import { parseResourceId, resourceOutputPath } from "./resourceIds";
import type { RsglCompileContext, TemplateExpansion } from "./templateExpansion";

export interface BlockstateCompileOptions extends BlockstateJsonValueLoweringHost {
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
  getBlockstateApplyFact?: (
    node: RsglBlockstateApplySiteNode
  ) => RsglBlockstateApplyFact | undefined;
}

export function compileBlockstateResource(
  statement: ResourceDeclNode,
  context: RsglCompileContext,
  options: BlockstateCompileOptions
): ResourceUnit | null {
  if (statement.resourceKind !== "blockstate") {
    options.onError(
      "rsgl.invalidBlockstateDeclaration",
      "The blockstate compiler received a non-blockstate resource declaration.",
      statement.range
    );
    return null;
  }

  const idValue = staticText(statement.id, context);
  const id = idValue ? parseResourceId(idValue, context.namespace) : null;
  if (!id) {
    options.onError(
      "rsgl.compileMissingResourceId",
      "Blockstate declaration requires a static id.",
      statement.range
    );
    return null;
  }

  const executor = new BlockstateOperationExecutor(executorHost(options, context.sourceFile));
  const canonical = statement.blockstateSyntax === "modeHeader";
  const program = canonical
    ? canonicalBlockstateOperationProgram(statement.body)
    : legacyBlockstateOperationProgram(statement.body);
  const inferredLegacyMode = !canonical
    && (program.mode === "variants" || program.mode === "multipart")
    ? program.mode
    : undefined;
  const finalizeOrigin = canonical
    ? { sourceRange: statement.modeNode.range, context }
    : undefined;
  const body = executor.executeRoot(program, context, {
    ...(canonical
      ? { declaredMode: statement.mode }
      : inferredLegacyMode
        ? { declaredMode: inferredLegacyMode }
        : {}),
    ...(finalizeOrigin ? { finalizeOrigin } : {}),
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

function executorHost(
  options: BlockstateCompileOptions,
  defaultSourceFile?: string
): BlockstateOperationExecutorHost {
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
    ...((options.sourceFile ?? defaultSourceFile)
      ? { sourceFile: options.sourceFile ?? defaultSourceFile }
      : {}),
    sourceMapping: options.sourceMapping,
    ...(options.getBlockstateApplyFact
      ? { getApplyFact: options.getBlockstateApplyFact }
      : {})
  };
}
