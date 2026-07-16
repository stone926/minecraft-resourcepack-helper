import type {
  ExprNode,
  ItemOptionNode,
  ObjectExprNode
} from "../parser";
import type { JsonValue } from "./ir";
import type {
  ItemModelExecutorHost,
  MutableItemModelLowering
} from "./itemModelExecutorTypes";
import { staticObjectKey } from "./itemModelJson";
import {
  commitCapturedItemModelObservations,
  evaluateCapturedItemModelExpression,
  itemModelExpressionMappings
} from "./itemModelLoweringSupport";
import type { ResourceBodyMapping } from "./resourceBody";
import { appendGeneratedPath } from "./sourcePaths";
import type { RsglCompileContext } from "./templateExpansion";

export interface LoweredItemPropertyHeader {
  readonly property: string;
  readonly options: Record<string, JsonValue>;
  readonly mappings: ResourceBodyMapping[];
}

/** Lowers a property expression and its context-sensitive option list. */
export function lowerItemPropertyHeader(
  propertyExpression: ExprNode,
  propertyOptions: readonly ItemOptionNode[],
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string
): LoweredItemPropertyHeader | undefined {
  const propertyPath = appendGeneratedPath(generatedPath, "property");
  const property = evaluateCapturedItemModelExpression(propertyExpression, context, host, propertyPath);
  if (!property || typeof property.evaluated.value !== "string") {
    host.onError?.(
      "rsgl.invalidItemFragmentArgument",
      "Item-model property must evaluate to a resource-id string.",
      propertyExpression.range,
      context.sourceFile
    );
    return undefined;
  }
  commitCapturedItemModelObservations(host, property.observations, propertyPath, false);
  const options: Record<string, JsonValue> = {};
  const mappings = itemModelExpressionMappings(
    property.evaluated,
    propertyExpression.range,
    context,
    propertyPath
  );
  const seen = new Set<string>();
  for (const item of propertyOptions) {
    const name = item.name.text;
    if (seen.has(name)) {
      host.onError?.(
        "rsgl.duplicateItemPropertyOption",
        `Duplicate item-model property option '${name}'.`,
        item.range,
        context.sourceFile
      );
      continue;
    }
    seen.add(name);
    const optionPath = appendGeneratedPath(generatedPath, name);
    const evaluated = evaluateCapturedItemModelExpression(item.value, context, host, optionPath);
    if (!evaluated) {
      continue;
    }
    commitCapturedItemModelObservations(host, evaluated.observations, optionPath, false);
    options[name] = evaluated.evaluated.value;
    mappings.push(...itemModelExpressionMappings(
      evaluated.evaluated,
      item.value.range,
      context,
      optionPath
    ));
  }
  return { property: property.evaluated.value, options, mappings };
}

/** Applies the closed postfix-option set accepted by one item-model node kind. */
export function applyItemModelPostfixOptions(
  lowering: MutableItemModelLowering,
  optionsNode: ObjectExprNode | undefined,
  allowedKeys: readonly string[],
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string
): void {
  if (!optionsNode) {
    return;
  }
  const seen = new Set<string>();
  for (const entry of optionsNode.properties) {
    if (entry.kind === "ObjectSpread") {
      host.onError?.(
        "rsgl.invalidItemModelOption",
        "Item-model postfix options do not allow spread entries.",
        entry.range,
        context.sourceFile
      );
      continue;
    }
    const key = staticObjectKey(entry.key);
    if (!key) {
      host.onError?.(
        "rsgl.invalidItemModelOption",
        "Item-model postfix options require static identifier or string keys.",
        entry.key.range,
        context.sourceFile
      );
      continue;
    }
    if (seen.has(key)) {
      host.onError?.(
        "rsgl.duplicateItemModelOption",
        `Duplicate item-model postfix option '${key}'.`,
        entry.range,
        context.sourceFile
      );
      continue;
    }
    seen.add(key);
    if (!allowedKeys.includes(key)) {
      host.onError?.(
        "rsgl.invalidItemModelOption",
        `Item-model node does not support postfix option '${key}'.`,
        entry.range,
        context.sourceFile
      );
      continue;
    }
    const optionPath = appendGeneratedPath(generatedPath, key);
    const evaluated = evaluateCapturedItemModelExpression(entry.value, context, host, optionPath);
    if (!evaluated) {
      continue;
    }
    commitCapturedItemModelObservations(host, evaluated.observations, optionPath, false);
    lowering.value[key] = evaluated.evaluated.value;
    lowering.mappings.push(...itemModelExpressionMappings(
      evaluated.evaluated,
      entry.value.range,
      context,
      optionPath
    ));
  }
}
