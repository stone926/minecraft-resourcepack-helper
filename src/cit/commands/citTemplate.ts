import * as path from "node:path";
import {
  minecraftResourceDirectory,
  parseAssetsPath,
  stripPathExtension
} from "../../../packages/mc-assets/src";
import { citresewnSourceDirectory } from "../../resources/citResourceSurface";

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

const itemDefinitionDirectory = minecraftResourceDirectory("item");
const itemModelDirectory = `${minecraftResourceDirectory("model")}/item`;
const itemTextureDirectory = `${minecraftResourceDirectory("texture")}/item`;

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
    fileName: path.join(
      resource.packRoot,
      "assets",
      resource.namespace,
      citresewnSourceDirectory,
      "cit",
      `${item.fileStem}.properties`
    ),
    text: `${lines.join("\n")}\n`
  };
}

export function getAssetResourceInfo(fileName: string): AssetResourceInfo | null {
  const parsed = parseAssetsPath(fileName);
  if (!parsed || parsed.relativeSegments.length === 0) {
    return null;
  }

  return {
    packRoot: path.dirname(parsed.assetsRoot),
    namespace: parsed.namespace,
    resourcePath: parsed.relativeSegments.join("/")
  };
}

function inferItemResource(resource: AssetResourceInfo): {
  itemId: string;
  fileStem: string;
  model?: string;
  texture?: string;
} | null {
  const resourcePath = resource.resourcePath.replaceAll("\\", "/");
  if (resourcePath.startsWith(`${itemDefinitionDirectory}/`) && resourcePath.endsWith(".json")) {
    const idPath = stripPathExtension(resourcePath.slice(itemDefinitionDirectory.length + 1));
    return {
      itemId: `${resource.namespace}:${idPath}`,
      fileStem: path.posix.basename(idPath)
    };
  }

  if (resourcePath.startsWith(`${itemModelDirectory}/`) && resourcePath.endsWith(".json")) {
    const idPath = stripPathExtension(resourcePath.slice(itemModelDirectory.length + 1));
    return {
      itemId: `${resource.namespace}:${idPath}`,
      fileStem: path.posix.basename(idPath),
      model: `${resource.namespace}:item/${idPath}`
    };
  }

  if (resourcePath.startsWith(`${itemTextureDirectory}/`) && resourcePath.endsWith(".png")) {
    const idPath = stripPathExtension(resourcePath.slice(itemTextureDirectory.length + 1));
    return {
      itemId: `${resource.namespace}:${idPath}`,
      fileStem: path.posix.basename(idPath),
      texture: `${resource.namespace}:item/${idPath}`
    };
  }

  return null;
}

