import { BinaryCopyRef, isExternalResourceUnit, JsonValue, ResourceKind, ResourceUnit, RsglSourceMap } from "./ir";

const objectFieldOrder: Record<string, string[]> = {
  model: ["parent", "ambientocclusion", "gui_light", "display", "textures", "elements"],
  blockstateModel: ["model", "x", "y", "z", "uvlock", "weight"],
  item: ["hand_animation_on_swap", "oversized_in_gui", "swap_animation_scale", "model"],
  itemModel: ["type", "property", "component", "index", "scale", "cases", "entries", "fallback", "model", "models", "tints"]
};

export type RsglEmittedFile = RsglContentEmittedFile | RsglCopyEmittedFile;

export interface RsglContentEmittedFile {
  outputPath: string;
  content: string;
  kind: "resource" | "sourceMap" | "manifest";
}

export interface RsglCopyEmittedFile {
  outputPath: string;
  copyFrom: string;
  kind: "resource";
}

export interface RsglEmitOptions {
  indent?: number;
  sourceMaps?: boolean;
  manifest?: boolean;
  sourceMapExtension?: string;
  manifestPath?: string;
}

export function stableJsonStringify(value: JsonValue, resourceKind: ResourceKind, indent = 2): string {
  return `${JSON.stringify(orderJsonValue(value, resourceKind), null, indent)}\n`;
}

export function emitRsglFiles(units: ResourceUnit[], options: RsglEmitOptions = {}): RsglEmittedFile[] {
  const indent = options.indent ?? 2;
  const sourceMapExtension = options.sourceMapExtension ?? ".rsgl.map";
  const sortedUnits = [...units].sort((left, right) => left.outputPath.localeCompare(right.outputPath));
  const files: RsglEmittedFile[] = [];

  for (const unit of sortedUnits) {
    if (isExternalResourceUnit(unit)) {
      continue;
    }
    files.push(resourceFile(unit, indent));

    if (options.sourceMaps) {
      files.push({
        outputPath: `${unit.outputPath}${sourceMapExtension}`,
        content: sourceMapStringify(unit.sourceMap, indent),
        kind: "sourceMap"
      });
    }
  }

  if (options.manifest) {
    files.push({
      outputPath: options.manifestPath ?? "rsgl.manifest.json",
      content: manifestStringify(sortedUnits, options.sourceMaps ? sourceMapExtension : undefined, indent),
      kind: "manifest"
    });
  }

  return files;
}

function resourceFile(unit: ResourceUnit, indent: number): RsglEmittedFile {
  if (unit.kind === "copy" && isBinaryCopyRef(unit.content)) {
    return {
      outputPath: unit.outputPath,
      copyFrom: unit.content.sourcePath,
      kind: "resource"
    };
  }
  return {
    outputPath: unit.outputPath,
    content: stringifyResourceContent(unit, indent),
    kind: "resource"
  };
}

function stringifyResourceContent(unit: ResourceUnit, indent: number): string {
  if (unit.kind === "text") {
    return isTextContent(unit.content) ? unit.content.text : "";
  }
  return stableJsonStringify(unit.content as JsonValue, unit.kind, indent);
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

function isTextContent(value: unknown): value is { kind: "text"; text: string } {
  return isObject(value) && value.kind === "text" && typeof value.text === "string";
}

function isBinaryCopyRef(value: unknown): value is BinaryCopyRef {
  return isObject(value) && value.kind === "copy" && typeof value.sourcePath === "string";
}

function sourceMapStringify(sourceMap: RsglSourceMap, indent: number): string {
  return `${JSON.stringify({
    version: 1,
    generatedFile: sourceMap.generatedFile,
    mappings: sourceMap.mappings
  }, null, indent)}\n`;
}

function manifestStringify(units: ResourceUnit[], sourceMapExtension: string | undefined, indent: number): string {
  const emittedUnits = units.filter(unit => !isExternalResourceUnit(unit));
  const externalUnits = units.filter(isExternalResourceUnit);
  return `${JSON.stringify({
    version: 1,
    generator: "minecraft-resourcepack-helper/rsgl",
    files: emittedUnits.map(unit => ({
      outputPath: unit.outputPath,
      kind: unit.kind,
      id: unit.id ? `${unit.id.namespace}:${unit.id.path}` : undefined,
      sourceMap: sourceMapExtension ? `${unit.outputPath}${sourceMapExtension}` : undefined
    })),
    externalResources: externalUnits.map(unit => ({
      outputPath: unit.outputPath,
      kind: unit.kind,
      id: unit.id ? `${unit.id.namespace}:${unit.id.path}` : undefined,
      source: unit.external ? {
        kind: unit.external.resourceKind,
        id: unit.external.id
      } : undefined
    }))
  }, null, indent)}\n`;
}
