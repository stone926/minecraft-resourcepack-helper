/* eslint-disable @typescript-eslint/naming-convention */
import { JsonValue, ResourceUnit } from "./ir";
import { parseResourceId, resourceOutputPath } from "./resourceIds";

const facings = ["north", "east", "south", "west"] as const;
const halves = ["bottom", "top"] as const;
const shapes = ["straight", "inner_left", "inner_right", "outer_left", "outer_right"] as const;

const stairsYaw: Record<string, Record<string, Record<string, number>>> = {
  bottom: {
    straight: { north: 270, east: 0, south: 90, west: 180 },
    inner_left: { north: 180, east: 270, south: 0, west: 90 },
    inner_right: { north: 270, east: 0, south: 90, west: 180 },
    outer_left: { north: 180, east: 270, south: 0, west: 90 },
    outer_right: { north: 270, east: 0, south: 90, west: 180 }
  },
  top: {
    straight: { north: 270, east: 0, south: 90, west: 180 },
    inner_left: { north: 270, east: 0, south: 90, west: 180 },
    inner_right: { north: 0, east: 90, south: 180, west: 270 },
    outer_left: { north: 270, east: 0, south: 90, west: 180 },
    outer_right: { north: 0, east: 90, south: 180, west: 270 }
  }
};

export function createStairsBlockstate(idValue: string, namespace: string, sourceFile: string, sourceRange: { start: number; end: number }): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  const variants: Record<string, JsonValue> = {};
  for (const half of halves) {
    for (const shape of shapes) {
      for (const facing of facings) {
        const modelKind = shape === "straight" ? "" : shape.startsWith("inner") ? "_inner" : "_outer";
        const entry: Record<string, JsonValue> = { model: `${id.namespace}:block/${id.path}${modelKind}` };
        if (half === "top") {
          entry.x = 180;
        }
        const y = stairsYaw[half][shape][facing];
        if (y !== 0) {
          entry.y = y;
        }
        if (entry.x || entry.y) {
          entry.uvlock = true;
        }
        variants[`facing=${facing},half=${half},shape=${shape}`] = entry;
      }
    }
  }
  return blockstateUnit(idValue, namespace, { variants }, sourceFile, sourceRange, "builtin");
}

export function createSlabBlockstate(
  idValue: string,
  doubleModel: string,
  namespace: string,
  sourceFile: string,
  sourceRange: { start: number; end: number }
): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  return blockstateUnit(idValue, namespace, {
    variants: {
      "type=bottom": { model: `${id.namespace}:block/${id.path}` },
      "type=top": { model: `${id.namespace}:block/${id.path}_top` },
      "type=double": { model: doubleModel.includes(":") ? doubleModel : `${namespace}:${doubleModel}` }
    }
  }, sourceFile, sourceRange, "builtin");
}

export function createFenceBlockstate(idValue: string, namespace: string, sourceFile: string, sourceRange: { start: number; end: number }): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  const multipart: JsonValue[] = [
    { apply: { model: `${id.namespace}:block/${id.path}_post` } }
  ];
  facings.forEach((facing, index) => {
    const apply: Record<string, JsonValue> = { model: `${id.namespace}:block/${id.path}_side` };
    if (index > 0) {
      apply.y = index * 90;
    }
    if (index > 0) {
      apply.uvlock = true;
    }
    multipart.push({ when: { [facing]: true }, apply });
  });
  return blockstateUnit(idValue, namespace, { multipart }, sourceFile, sourceRange, "builtin");
}

export function createWallBlockstate(idValue: string, namespace: string, sourceFile: string, sourceRange: { start: number; end: number }): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  const multipart: JsonValue[] = [
    { when: { up: true }, apply: { model: `${id.namespace}:block/${id.path}_post` } }
  ];
  facings.forEach((facing, index) => {
    for (const height of ["low", "tall"]) {
      const apply: Record<string, JsonValue> = { model: `${id.namespace}:block/${id.path}_side${height === "tall" ? "_tall" : ""}` };
      if (index > 0) {
        apply.y = index * 90;
        apply.uvlock = true;
      }
      multipart.push({ when: { [facing]: height }, apply });
    }
  });
  return blockstateUnit(idValue, namespace, { multipart }, sourceFile, sourceRange, "builtin");
}

export function createCubeAllModel(idValue: string, textureValue: string | undefined, namespace: string, sourceFile: string, sourceRange: { start: number; end: number }): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  const texture = textureValue ? normalizeResourceValue(textureValue, namespace, "block") : `${id.namespace}:block/${id.path}`;
  return {
    id,
    kind: "model",
    outputPath: resourceOutputPath("model", { namespace: id.namespace, path: `block/${id.path}` }),
    content: {
      parent: "minecraft:block/cube_all",
      textures: { all: texture }
    },
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: sourceMap(resourceOutputPath("model", { namespace: id.namespace, path: `block/${id.path}` }), sourceFile, sourceRange, "builtin")
  };
}

export function createItemMapping(idValue: string, modelValue: string | undefined, namespace: string, sourceFile: string, sourceRange: { start: number; end: number }): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  const model = modelValue ? normalizeResourceValue(modelValue, namespace, "item") : `${id.namespace}:item/${id.path}`;
  return {
    id,
    kind: "item",
    outputPath: resourceOutputPath("item", id),
    content: {
      model: {
        type: "minecraft:model",
        model
      }
    },
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: sourceMap(resourceOutputPath("item", id), sourceFile, sourceRange, "builtin")
  };
}

function blockstateUnit(
  idValue: string,
  namespace: string,
  content: JsonValue,
  sourceFile: string,
  sourceRange: { start: number; end: number },
  reason: "direct" | "builtin"
): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  const outputPath = resourceOutputPath("blockstate", id);
  return {
    id,
    kind: "blockstate",
    outputPath,
    content,
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: sourceMap(outputPath, sourceFile, sourceRange, reason)
  };
}

function normalizeResourceValue(value: string, namespace: string, defaultFolder: string): string {
  if (value.includes(":")) {
    return value;
  }
  return `${namespace}:${value.includes("/") ? value : `${defaultFolder}/${value}`}`;
}

function sourceMap(outputPath: string, sourceFile: string, sourceRange: { start: number; end: number }, reason: "direct" | "builtin") {
  return {
    generatedFile: outputPath,
    mappings: [{
      generatedPath: "",
      sourceFile,
      sourceRange,
      reason,
      expansionStack: reason === "builtin" ? [{ label: "builtin template", sourceRange }] : []
    }]
  };
}
