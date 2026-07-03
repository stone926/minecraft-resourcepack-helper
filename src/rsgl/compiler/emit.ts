import { JsonValue, ResourceKind } from "./ir";

const objectFieldOrder: Record<string, string[]> = {
  model: ["parent", "ambientocclusion", "gui_light", "display", "textures", "elements"],
  blockstateModel: ["model", "x", "y", "z", "uvlock", "weight"],
  item: ["hand_animation_on_swap", "oversized_in_gui", "swap_animation_scale", "model"],
  itemModel: ["type", "property", "component", "index", "scale", "cases", "entries", "fallback", "model", "models", "tints"]
};

export function stableJsonStringify(value: JsonValue, resourceKind: ResourceKind, indent = 2): string {
  return `${JSON.stringify(orderJsonValue(value, resourceKind), null, indent)}\n`;
}

export function orderJsonValue(value: JsonValue, resourceKind: ResourceKind): JsonValue {
  if (Array.isArray(value)) {
    return value.map(item => orderJsonValue(item, resourceKind));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const order = getFieldOrder(value, resourceKind);
  const keys = Object.keys(value);
  const orderedKeys = [
    ...order.filter(key => keys.includes(key)),
    ...keys.filter(key => !order.includes(key)).sort()
  ];
  const result: Record<string, JsonValue> = {};
  for (const key of orderedKeys) {
    const childKind = key === "model" && resourceKind === "item" && isObject(value[key]) ? "itemModel" : resourceKind;
    result[key] = orderJsonValue(value[key] as JsonValue, childKind as ResourceKind);
  }
  return result;
}

function getFieldOrder(value: Record<string, unknown>, resourceKind: ResourceKind | "itemModel"): string[] {
  if (resourceKind === "model") {
    return objectFieldOrder.model;
  }
  if (resourceKind === "item") {
    return objectFieldOrder.item;
  }
  if (resourceKind === "itemModel") {
    return objectFieldOrder.itemModel;
  }
  if ("model" in value) {
    return objectFieldOrder.blockstateModel;
  }
  return [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
