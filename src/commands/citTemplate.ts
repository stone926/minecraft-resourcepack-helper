import * as path from "node:path";

export type CitTemplateType = "item" | "armor" | "elytra" | "enchantment";

export interface AssetResourceInfo {
  packRoot: string;
  namespace: string;
  resourcePath: string;
}

export interface GeneratedCit {
  fileName: string;
  text: string;
}

export function createCitTemplate(type: CitTemplateType, itemId = "minecraft:stick"): string {
  if (type === "armor") {
    return [
      "type=armor",
      `items=${itemId}`,
      "texture.layer_1=./armor_layer_1"
    ].join("\n") + "\n";
  }

  if (type === "elytra") {
    return [
      "type=elytra",
      "texture=./elytra"
    ].join("\n") + "\n";
  }

  if (type === "enchantment") {
    return [
      "type=enchantment",
      "texture=./glint",
      "blend=add",
      "speed=0.0",
      "rotation=0.0"
    ].join("\n") + "\n";
  }

  return [
    "type=item",
    `items=${itemId}`,
    "texture=./texture"
  ].join("\n") + "\n";
}

export function generateCitForResource(fileName: string): GeneratedCit | null {
  const resource = getAssetResourceInfo(fileName);
  if (!resource) {
    return null;
  }

  const item = inferItemResource(resource);
  if (!item) {
    return null;
  }

  const lines = [
    "type=item",
    `items=${item.itemId}`
  ];
  if (item.model) {
    lines.push(`model=${item.model}`);
  }
  if (item.texture) {
    lines.push(`texture=${item.texture}`);
  }

  return {
    fileName: path.join(resource.packRoot, "assets", resource.namespace, "citresewn", "cit", `${item.fileStem}.properties`),
    text: `${lines.join("\n")}\n`
  };
}

export function getAssetResourceInfo(fileName: string): AssetResourceInfo | null {
  const normalized = path.normalize(fileName);
  const parsed = path.parse(normalized);
  const segments = path.relative(parsed.root, normalized).split(path.sep).filter(Boolean);
  const assetsIndex = findLastIndex(segments, segment => segment.toLowerCase() === "assets");
  if (assetsIndex < 0 || segments.length <= assetsIndex + 2) {
    return null;
  }

  return {
    packRoot: path.join(parsed.root, ...segments.slice(0, assetsIndex)),
    namespace: segments[assetsIndex + 1],
    resourcePath: segments.slice(assetsIndex + 2).join("/")
  };
}

function inferItemResource(resource: AssetResourceInfo): {
  itemId: string;
  fileStem: string;
  model?: string;
  texture?: string;
} | null {
  const resourcePath = resource.resourcePath.replaceAll("\\", "/");
  if (resourcePath.startsWith("items/") && resourcePath.endsWith(".json")) {
    const idPath = stripExtension(resourcePath.slice("items/".length));
    return {
      itemId: `${resource.namespace}:${idPath}`,
      fileStem: path.posix.basename(idPath)
    };
  }

  if (resourcePath.startsWith("models/item/") && resourcePath.endsWith(".json")) {
    const idPath = stripExtension(resourcePath.slice("models/item/".length));
    return {
      itemId: `${resource.namespace}:${idPath}`,
      fileStem: path.posix.basename(idPath),
      model: `${resource.namespace}:item/${idPath}`
    };
  }

  if (resourcePath.startsWith("textures/item/") && resourcePath.endsWith(".png")) {
    const idPath = stripExtension(resourcePath.slice("textures/item/".length));
    return {
      itemId: `${resource.namespace}:${idPath}`,
      fileStem: path.posix.basename(idPath),
      texture: `${resource.namespace}:item/${idPath}`
    };
  }

  return null;
}

function stripExtension(value: string): string {
  const extension = path.posix.extname(value);
  return extension ? value.slice(0, -extension.length) : value;
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (predicate(values[index])) {
      return index;
    }
  }

  return -1;
}
