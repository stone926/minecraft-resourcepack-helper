import type {
  ItemModelExprNode,
  ItemModelProducerStmtNode,
  PropertyStmtNode,
  ResourceBodyNode,
  ResourceStatementNode,
  TextRange
} from "../parser";
import { DEFAULT_MAX_ITEM_MODEL_DEPTH } from "./compileConfiguration";
import {
  childEvaluationContext,
  evaluateCompileTimeCondition
} from "./evaluate";
import type { JsonValue } from "./ir";
import {
  createJsonObject,
  jsonObjectEntries,
  setJsonObjectProperty
} from "./jsonObjectProperties";
import { forEachLoopContext } from "./looping";
import {
  executeItemModelNode,
  executeItemModelUseExpression,
  normalizeItemModelValue,
  type ItemModelExecutorHost,
  type LoweredItemModel
} from "./itemModelExecutor";
import { findItemModelDepthViolation } from "./itemModelDepth";
import {
  applyResolvedResourceBodyProperty,
  applyResourceBodyStatement,
  resolveResourceBodyPropertyKey,
  type ResourceBodyCompileOptions,
  type ResourceBodyMapping
} from "./resourceBody";
import { applyResourceBodyFragment } from "./resourceBodyContentMerge";
import type { RsglCompileContext } from "./templateExpansion";

export interface ItemOperationExecutorHost extends ItemModelExecutorHost {
  /** Generic item resource-body hooks used below the item root boundary. */
  readonly resourceBodyOptions: ResourceBodyCompileOptions;
}

export interface CompiledItemResourceBody {
  readonly content: Record<string, JsonValue>;
  readonly mappings: readonly ResourceBodyMapping[];
}

interface ItemExecutionState {
  producerCount: number;
  /** Suppresses a redundant missing-root error when a producer already failed. */
  producerIntentSeen: boolean;
}

interface ItemExecutionFrame {
  readonly content: Record<string, JsonValue>;
  readonly mappings: ResourceBodyMapping[];
  /** The final model in this fragment must be committed atomically. */
  atomicModelProduced: boolean;
}

/**
 * Executes an item root in source order while delegating all ordinary JSON
 * operations to the generic resource-body engine. Direct model producers are
 * the sole specialization: they share one expanded-root counter and replace
 * `/model` as an atomic value.
 */
export function executeItemResourceBody(
  body: ResourceBodyNode,
  context: RsglCompileContext,
  host: ItemOperationExecutorHost
): CompiledItemResourceBody {
  const state: ItemExecutionState = { producerCount: 0, producerIntentSeen: false };
  const frame = executeFrame(body, context, host, state, true);
  normalizeFinalModel(frame, context);
  reportFinalModelDepth(frame, body.range, context, host);
  if (!Object.hasOwn(frame.content, "model") && !state.producerIntentSeen) {
    host.onError?.(
      "rsgl.compileMissingItemModel",
      "Item definition must produce a root 'model' after base and merge operations are applied.",
      body.range,
      context.sourceFile
    );
  }
  return { content: frame.content, mappings: frame.mappings };
}

function reportFinalModelDepth(
  frame: ItemExecutionFrame,
  fallbackRange: TextRange,
  context: RsglCompileContext,
  host: ItemOperationExecutorHost
): void {
  const model = frame.content.model;
  if (model === undefined) {
    return;
  }
  const maxDepth = host.maxItemModelDepth ?? DEFAULT_MAX_ITEM_MODEL_DEPTH;
  const violation = findItemModelDepthViolation(model, maxDepth);
  if (!violation) {
    return;
  }
  const mapping = mostSpecificModelMapping(frame.mappings, violation.generatedPath);
  const origin = mapping?.validationOrigin;
  host.onError?.(
    "rsgl.itemModelDepthExceeded",
    `Item-model node at '${violation.generatedPath}' exceeds maxItemModelDepth=${maxDepth}.`,
    origin?.sourceRange ?? mapping?.sourceRange ?? fallbackRange,
    origin?.sourceFile ?? mapping?.context.sourceFile ?? context.sourceFile
  );
}

function mostSpecificModelMapping(
  mappings: readonly ResourceBodyMapping[],
  generatedPath: string
): ResourceBodyMapping | undefined {
  let best: ResourceBodyMapping | undefined;
  for (const mapping of mappings) {
    if (
      generatedPath !== mapping.generatedPath
      && !generatedPath.startsWith(`${mapping.generatedPath}/`)
    ) {
      continue;
    }
    if (!best || mapping.generatedPath.length > best.generatedPath.length) {
      best = mapping;
    }
  }
  return best;
}

function executeFrame(
  body: ResourceBodyNode,
  context: RsglCompileContext,
  host: ItemOperationExecutorHost,
  state: ItemExecutionState,
  concreteRoot: boolean
): ItemExecutionFrame {
  const frame: ItemExecutionFrame = {
    content: createJsonObject(),
    mappings: [],
    atomicModelProduced: false
  };
  const options = frameOptions(host, frame.mappings);
  body.statements.forEach((statement, index) => {
    executeStatement(
      frame,
      statement,
      context,
      host,
      state,
      options,
      concreteRoot,
      index === 0
    );
  });
  return frame;
}

function executeStatement(
  frame: ItemExecutionFrame,
  statement: ResourceStatementNode,
  context: RsglCompileContext,
  host: ItemOperationExecutorHost,
  state: ItemExecutionState,
  options: ResourceBodyCompileOptions,
  concreteRoot: boolean,
  firstStatement: boolean
): void {
  if (statement.kind === "ItemModelProducerStmt") {
    executeProducer(frame, statement, context, host, state, options);
    return;
  }
  if (statement.kind === "PropertyStmt") {
    const key = resolveResourceBodyPropertyKey(statement, context, options);
    if (key === null) {
      return;
    }
    if (key === "model") {
      executeProducer(
        frame,
        canonicalPropertyProducer(statement),
        context,
        host,
        state,
        options
      );
    } else {
      applyResolvedResourceBodyProperty(
        frame.content,
        statement,
        key,
        context,
        options,
        ""
      );
    }
    return;
  }
  if (statement.kind === "UseDecl") {
    executeRootUse(frame, statement.expression, statement.range, context, host, state, options);
    return;
  }
  if (statement.kind === "IfStmt") {
    const selected = selectedResourceBody(statement, context);
    if (!selected) {
      return;
    }
    const child = executeFrame(
      selected,
      childEvaluationContext(context, {}) as RsglCompileContext,
      host,
      state,
      false
    );
    commitControlFlowFrame(frame, child, statement.range, context, options);
    return;
  }
  if (statement.kind === "ForStmt") {
    if (statement.body.kind !== "ResourceBody") {
      host.onError?.(
        "rsgl.invalidItemRootControlBody",
        "Item-root loops must preserve a resource body.",
        statement.body.range,
        context.sourceFile
      );
      return;
    }
    forEachLoopContext(
      statement,
      context,
      (code, message, range) => host.onError?.(code, message, range, context.sourceFile),
      loopContext => {
        const child = executeFrame(
          statement.body as ResourceBodyNode,
          loopContext as RsglCompileContext,
          host,
          state,
          false
        );
        commitControlFlowFrame(frame, child, statement.range, loopContext, options);
      }
    );
    return;
  }

  applyResourceBodyStatement(
    frame.content,
    statement,
    context,
    options,
    "",
    concreteRoot,
    firstStatement
  );
}

function executeProducer(
  frame: ItemExecutionFrame,
  statement: ItemModelProducerStmtNode,
  context: RsglCompileContext,
  host: ItemOperationExecutorHost,
  state: ItemExecutionState,
  options: ResourceBodyCompileOptions
): void {
  state.producerIntentSeen = true;
  if (!acceptProducer(state, statement.range, context, host)) {
    return;
  }
  const lowered = executeItemModelNode(statement.value, context, host, "/model", 0);
  if (lowered) {
    applyAtomicModel(frame, lowered, statement.range, context, options);
  }
}

function executeRootUse(
  frame: ItemExecutionFrame,
  expression: Extract<ResourceStatementNode, { kind: "UseDecl" }>["expression"],
  range: TextRange,
  context: RsglCompileContext,
  host: ItemOperationExecutorHost,
  state: ItemExecutionState,
  options: ResourceBodyCompileOptions
): void {
  state.producerIntentSeen = true;
  const definition = host.resolveTemplate(expression, context);
  if (!definition) {
    // Reuse the item-model executor's stable unknown-template diagnostic.
    executeItemModelUseExpression(expression, range, context, host, "/model", 0);
    return;
  }
  const dispatch = host.resolveTemplateDispatch(definition, { kind: "itemModel" });
  if (!dispatch.compatible || dispatch.selectedDialect !== "item_model") {
    return;
  }
  const lowered = executeItemModelUseExpression(expression, range, context, host, "/model", 0);
  if (!lowered || !acceptProducer(state, range, context, host)) {
    return;
  }
  applyAtomicModel(frame, lowered, range, context, options);
}

/** Applies the producer normalization contract to models supplied by base/merge. */
function normalizeFinalModel(
  frame: ItemExecutionFrame,
  context: RsglCompileContext
): void {
  const value = frame.content.model;
  if (value === undefined) {
    return;
  }
  const normalized = normalizeItemModelValue(value, context.namespace);
  if (normalized) {
    setJsonObjectProperty(frame.content, "model", normalized);
  }
}

function acceptProducer(
  state: ItemExecutionState,
  range: TextRange,
  context: RsglCompileContext,
  host: ItemOperationExecutorHost
): boolean {
  state.producerCount++;
  if (state.producerCount === 1) {
    return true;
  }
  host.onError?.(
    "rsgl.multipleItemModelProducers",
    "An expanded item root may contain at most one direct model producer; the first producer is kept.",
    range,
    context.sourceFile
  );
  return false;
}

function applyAtomicModel(
  frame: ItemExecutionFrame,
  lowered: LoweredItemModel,
  range: TextRange,
  context: RsglCompileContext,
  options: ResourceBodyCompileOptions
): void {
  applyResourceBodyFragment(
    frame.content,
    {
      content: { model: lowered.value },
      mappings: [...lowered.mappings]
    },
    "shallow",
    range,
    context,
    options,
    ""
  );
  frame.atomicModelProduced = true;
}

function commitControlFlowFrame(
  target: ItemExecutionFrame,
  child: ItemExecutionFrame,
  range: TextRange,
  context: RsglCompileContext,
  options: ResourceBodyCompileOptions
): void {
  if (!child.atomicModelProduced) {
    applyResourceBodyFragment(
      target.content,
      { content: child.content, mappings: child.mappings },
      "deep",
      range,
      context,
      options,
      ""
    );
    return;
  }

  const ordinaryContent = createJsonObject<JsonValue>();
  for (const [key, value] of jsonObjectEntries(child.content)) {
    if (key !== "model") {
      setJsonObjectProperty(ordinaryContent, key, value);
    }
  }
  const ordinaryMappings = child.mappings.filter(mapping => !isModelMapping(mapping));
  applyResourceBodyFragment(
    target.content,
    { content: ordinaryContent, mappings: ordinaryMappings },
    "deep",
    range,
    context,
    options,
    ""
  );

  if (Object.hasOwn(child.content, "model")) {
    const modelMappings = child.mappings.filter(isModelMapping);
    applyResourceBodyFragment(
      target.content,
      {
        content: { model: child.content.model },
        mappings: modelMappings
      },
      "shallow",
      range,
      context,
      options,
      ""
    );
    target.atomicModelProduced = true;
  }
}

function selectedResourceBody(
  statement: Extract<ResourceStatementNode, { kind: "IfStmt" }>,
  context: RsglCompileContext
): ResourceBodyNode | undefined {
  const condition = evaluateCompileTimeCondition(statement.condition, context);
  if (condition === undefined) {
    return undefined;
  }
  const selected = condition ? statement.thenBody : statement.elseBody;
  return selected?.kind === "ResourceBody" ? selected : undefined;
}

function canonicalPropertyProducer(statement: PropertyStmtNode): ItemModelProducerStmtNode {
  const value: ItemModelExprNode = {
    kind: "ItemModelExpr",
    expression: statement.value,
    range: statement.value.range,
    fullRange: statement.value.fullRange
  };
  return {
    kind: "ItemModelProducerStmt",
    keyword: statement.keyword,
    value,
    surfaceKind: "rawProperty",
    range: statement.range,
    fullRange: statement.fullRange
  };
}

function frameOptions(
  host: ItemOperationExecutorHost,
  mappings: ResourceBodyMapping[]
): ResourceBodyCompileOptions {
  const inheritedMapping = host.resourceBodyOptions.onMapping;
  return {
    ...host.resourceBodyOptions,
    onMapping: mapping => {
      mappings.push(mapping);
      inheritedMapping?.(mapping);
    }
  };
}

function isModelMapping(mapping: ResourceBodyMapping): boolean {
  return mapping.generatedPath === "/model" || mapping.generatedPath.startsWith("/model/");
}
