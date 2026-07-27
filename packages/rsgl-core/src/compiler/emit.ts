import { pathToFileURL } from "node:url";
import { canonicalizeResourceGraphOutputPath } from "../../../mc-assets/src";
import { blockstateModelOptionNames } from "../blockstateModelOptions";
import { BinaryCopyRef, isExternalResourceUnit, JsonValue, ResourceKind, ResourceUnit, RsglSourceMap } from "./ir";
import { createJsonObject, setJsonObjectProperty } from "./jsonObjectProperties";
import { isJsonObject } from "./jsonValues";
import { getRsglResourceKindDescriptor } from "../resourceKinds";

const objectFieldOrder: Record<string, string[]> = {
  model: ["parent", "ambientocclusion", "gui_light", "display", "textures", "elements"],
  blockstateModel: ["model", ...blockstateModelOptionNames, "weight"],
  item: ["hand_animation_on_swap", "oversized_in_gui", "swap_animation_scale", "model"],
  itemModel: ["type", "property", "component", "index", "scale", "cases", "entries", "fallback", "model", "models", "tints"]
};

export type RsglEmittedFile = RsglContentEmittedFile | RsglCopyEmittedFile;

/**
 * Contentless provenance carried from compile/emit into a materialization
 * transaction. The transaction assigns the project-scoped producer identity.
 */
export interface RsglEmittedOwnershipHint {
  kind: string;
  logicalKeys: readonly { kind: string; id: string }[];
  /** In-memory compile fact. Disk manifests project this URI to a portable source path. */
  sourceOrigins: readonly RsglEmittedSourceOrigin[];
  sourceMapPath?: string;
}

export interface RsglEmittedSourceOrigin {
  sourceUri: string;
  range?: { start: number; end: number };
}

export interface RsglContentEmittedFile {
  outputPath: string;
  content: string;
  kind: "resource" | "sourceMap" | "manifest";
  ownership?: RsglEmittedOwnershipHint;
}

export interface RsglCopyEmittedFile {
  outputPath: string;
  copyFrom: string;
  kind: "resource";
  ownership?: RsglEmittedOwnershipHint;
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
    const ownership = ownershipHint(unit, options.sourceMaps ? sourceMapExtension : undefined);
    files.push(resourceFile(unit, indent, ownership));

    if (options.sourceMaps) {
      files.push({
        outputPath: `${unit.outputPath}${sourceMapExtension}`,
        content: sourceMapStringify(unit.sourceMap, indent),
        kind: "sourceMap",
        ownership: {
          ...ownership,
          kind: "sourceMap",
          logicalKeys: [],
          sourceMapPath: undefined
        }
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

function resourceFile(
  unit: ResourceUnit,
  indent: number,
  ownership: RsglEmittedOwnershipHint
): RsglEmittedFile {
  const contentKind = getRsglResourceKindDescriptor(unit.kind)?.emit.contentKind;
  if (contentKind === "binaryCopy" && isBinaryCopyRef(unit.content)) {
    return {
      outputPath: unit.outputPath,
      copyFrom: unit.content.sourcePath,
      kind: "resource",
      ownership
    };
  }
  return {
    outputPath: unit.outputPath,
    content: stringifyResourceContent(unit, indent),
    kind: "resource",
    ownership
  };
}

function ownershipHint(
  unit: ResourceUnit,
  sourceMapExtension: string | undefined
): RsglEmittedOwnershipHint {
  const identity = canonicalizeResourceGraphOutputPath(unit.outputPath);
  const exactOrigins = unit.validation?.resourceDefinitionOrigins ?? [];
  const mappedOrigins = unit.sourceMap.mappings
    .filter(mapping => !mapping.validationOnly)
    .map(mapping => ({ sourceFile: mapping.sourceFile, sourceRange: mapping.sourceRange }));
  const origins = exactOrigins.length > 0 ? exactOrigins : mappedOrigins;
  const sourceOrigins = [...new Map(origins.map(origin => {
    const sourceUri = sourceFileUri(origin.sourceFile);
    const key = `${sourceUri}\0${origin.sourceRange.start}\0${origin.sourceRange.end}`;
    return [key, {
      sourceUri,
      range: { start: origin.sourceRange.start, end: origin.sourceRange.end }
    } satisfies RsglEmittedSourceOrigin] as const;
  })).values()];
  return {
    kind: unit.kind,
    logicalKeys: identity?.primaryCategory === "concrete" ? [identity.primaryKey] : [],
    sourceOrigins,
    ...(sourceMapExtension ? { sourceMapPath: `${unit.outputPath}${sourceMapExtension}` } : {})
  };
}

function sourceFileUri(fileName: string): string {
  if (fileName.startsWith("<")) {
    return `rsgl-source:${encodeURIComponent(fileName)}`;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(fileName)
    && !/^[a-zA-Z]:[\\/]/.test(fileName)) {
    return fileName;
  }
  return pathToFileURL(fileName).toString();
}

function stringifyResourceContent(unit: ResourceUnit, indent: number): string {
  if (getRsglResourceKindDescriptor(unit.kind)?.emit.contentKind === "text") {
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
  const result = createJsonObject();
  for (const key of orderedKeys) {
    const childKind = key === "model" && resourceKind === "item" && isJsonObject(value[key]) ? "itemModel" : resourceKind;
    setJsonObjectProperty(
      result,
      key,
      orderJsonValue(value[key] as JsonValue, childKind as ResourceKind)
    );
  }
  return result;
}

function getFieldOrder(value: Record<string, unknown>, resourceKind: ResourceKind | "itemModel"): string[] {
  const jsonOrder = resourceKind === "itemModel"
    ? "itemModel"
    : getRsglResourceKindDescriptor(resourceKind)?.emit.jsonOrder ?? "default";
  if (jsonOrder === "model") {
    return objectFieldOrder.model;
  }
  if (jsonOrder === "item") {
    return objectFieldOrder.item;
  }
  if (jsonOrder === "itemModel") {
    return objectFieldOrder.itemModel;
  }
  if ("model" in value) {
    return objectFieldOrder.blockstateModel;
  }
  return [];
}

function isTextContent(value: unknown): value is { kind: "text"; text: string } {
  return isJsonObject(value) && value.kind === "text" && typeof value.text === "string";
}

function isBinaryCopyRef(value: unknown): value is BinaryCopyRef {
  return isJsonObject(value) && value.kind === "copy" && typeof value.sourcePath === "string";
}

function sourceMapStringify(sourceMap: RsglSourceMap, indent: number): string {
  return `${JSON.stringify({
    version: 1,
    generatedFile: sourceMap.generatedFile,
    mappings: sourceMap.mappings.map(mapping => ({
      generatedPath: mapping.generatedPath,
      sourceFile: mapping.sourceFile,
      sourceRange: mapping.sourceRange,
      reason: mapping.reason,
      expansionStack: mapping.expansionStack
    }))
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
        origin: unit.external.source,
        kind: unit.external.resourceKind,
        id: unit.external.id,
        checkExistence: !unit.external.skipExistenceCheck
      } : undefined
    }))
  }, null, indent)}\n`;
}
