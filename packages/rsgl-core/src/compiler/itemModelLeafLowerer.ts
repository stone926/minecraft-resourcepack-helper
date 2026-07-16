import type { ItemModelNode } from "../parser";
import type {
  ItemModelExecutorHost,
  LoweredItemModel,
  MutableItemModelLowering
} from "./itemModelExecutorTypes";
import { normalizeItemModelValue, normalizeModelId } from "./itemModelJson";
import {
  commitCapturedItemModelObservations,
  evaluateCapturedItemModelExpression,
  itemModelExpressionMappings,
  itemModelNodeMapping
} from "./itemModelLoweringSupport";
import { applyItemModelPostfixOptions } from "./itemModelOptionsLowerer";
import { isJsonObject } from "./jsonValues";
import { appendGeneratedPath } from "./sourcePaths";
import type { RsglCompileContext } from "./templateExpansion";

/** Lowers a model-id or raw-object leaf without recursing into the item-model AST. */
export function lowerItemModelExpression(
  node: Extract<ItemModelNode, { kind: "ItemModelExpr" }>,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string
): LoweredItemModel | undefined {
  const captured = evaluateCapturedItemModelExpression(node.expression, context, host, generatedPath);
  if (!captured) {
    return undefined;
  }
  const normalized = normalizeItemModelValue(captured.evaluated.value, context.namespace);
  if (!normalized) {
    host.onError?.(
      "rsgl.invalidItemModel",
      "Item-model expression must evaluate to a ModelId or item-model object.",
      node.expression.range,
      context.sourceFile
    );
    return undefined;
  }
  const scalarModel = typeof captured.evaluated.value === "string";
  if (node.options && !scalarModel) {
    host.onError?.(
      "rsgl.itemModelOptionsOnRawObject",
      "Postfix 'with' options can only be attached to a model id expression, not a raw item-model object.",
      node.options.range,
      context.sourceFile
    );
  }
  commitCapturedItemModelObservations(host, captured.observations, generatedPath, scalarModel);
  const result: MutableItemModelLowering = {
    value: normalized,
    mappings: itemModelExpressionMappings(
      captured.evaluated,
      node.expression.range,
      context,
      generatedPath,
      scalarModel ? "model" : undefined
    )
  };
  if (node.options && scalarModel) {
    applyItemModelPostfixOptions(
      result,
      node.options,
      ["tints", "transformation"],
      context,
      host,
      generatedPath
    );
  }
  return result;
}

/** Lowers a special-renderer leaf and its base model. */
export function lowerItemModelSpecial(
  node: Extract<ItemModelNode, { kind: "ItemModelSpecial" }>,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string
): LoweredItemModel | undefined {
  const basePath = appendGeneratedPath(generatedPath, "base");
  const modelPath = appendGeneratedPath(generatedPath, "model");
  const base = evaluateCapturedItemModelExpression(node.base, context, host, basePath);
  const model = evaluateCapturedItemModelExpression(node.model, context, host, modelPath);
  if (!base || !model || typeof base.evaluated.value !== "string" || !isJsonObject(model.evaluated.value)) {
    host.onError?.(
      "rsgl.invalidItemSpecialModel",
      "Item special requires a base ModelId and a special model object.",
      node.range,
      context.sourceFile
    );
    return undefined;
  }
  commitCapturedItemModelObservations(host, base.observations, basePath, false);
  commitCapturedItemModelObservations(host, model.observations, modelPath, false);
  const result: MutableItemModelLowering = {
    value: {
      type: "minecraft:special",
      base: normalizeModelId(base.evaluated.value, context.namespace),
      model: model.evaluated.value
    },
    mappings: [
      itemModelNodeMapping(generatedPath, node.range, context),
      ...itemModelExpressionMappings(base.evaluated, node.base.range, context, basePath),
      ...itemModelExpressionMappings(model.evaluated, node.model.range, context, modelPath)
    ]
  };
  applyItemModelPostfixOptions(
    result,
    node.options,
    ["transformation"],
    context,
    host,
    generatedPath
  );
  return result;
}
