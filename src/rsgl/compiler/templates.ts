/* eslint-disable @typescript-eslint/naming-convention */
import { ExpansionFrame, JsonValue, ResourceUnit } from "./ir";
import { parseResourceId, resourceOutputPath } from "./resourceIds";

const facings = ["north", "east", "south", "west"] as const;
const halves = ["bottom", "top"] as const;
const shapes = ["straight", "inner_left", "inner_right", "outer_left", "outer_right"] as const;

export interface StairsBlockstateModels {
  base: string;
  inner: string;
  outer: string;
  uvlock?: boolean;
}

export interface SlabBlockstateModels {
  bottom: string;
  top: string;
  double: string;
}

export interface FenceBlockstateModels {
  post: string;
  side: string;
}

export interface FenceGateBlockstateModels {
  base: string;
  open: string;
  wall: string;
  wallOpen: string;
}

export interface WallBlockstateModels {
  post: string;
  side: string;
  sideTall: string;
}

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

const fenceGateYaw: Record<string, number> = {
  north: 180,
  east: 270,
  south: 0,
  west: 90
};

export function createStairsBlockstate(
  idValue: string,
  namespace: string,
  sourceFile: string,
  sourceRange: { start: number; end: number },
  expansionStack: ExpansionFrame[] = []
): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  return blockstateUnit(idValue, namespace, createStairsBlockstateContent({
    base: `${id.namespace}:block/${id.path}`,
    inner: `${id.namespace}:block/${id.path}_inner`,
    outer: `${id.namespace}:block/${id.path}_outer`
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createStairsBlockstateContent(models: StairsBlockstateModels): Record<string, JsonValue> {
  const variants: Record<string, JsonValue> = {};
  for (const half of halves) {
    for (const shape of shapes) {
      for (const facing of facings) {
        const entry: Record<string, JsonValue> = { model: stairsModelForShape(models, shape) };
        if (half === "top") {
          entry.x = 180;
        }
        const y = stairsYaw[half][shape][facing];
        if (y !== 0) {
          entry.y = y;
        }
        const uvlock = models.uvlock ?? Boolean(entry.x || entry.y);
        if (uvlock) {
          entry.uvlock = true;
        }
        variants[`facing=${facing},half=${half},shape=${shape}`] = entry;
      }
    }
  }
  return { variants };
}

export function createSlabBlockstate(
  idValue: string,
  doubleModel: string,
  namespace: string,
  sourceFile: string,
  sourceRange: { start: number; end: number },
  expansionStack: ExpansionFrame[] = []
): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  return blockstateUnit(idValue, namespace, createSlabBlockstateContent({
    bottom: `${id.namespace}:block/${id.path}`,
    top: `${id.namespace}:block/${id.path}_top`,
    double: doubleModel.includes(":") ? doubleModel : `${namespace}:${doubleModel}`
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createSlabBlockstateContent(models: SlabBlockstateModels): Record<string, JsonValue> {
  return {
    variants: {
      "type=bottom": { model: models.bottom },
      "type=top": { model: models.top },
      "type=double": { model: models.double }
    }
  };
}

export function createFenceBlockstate(
  idValue: string,
  namespace: string,
  sourceFile: string,
  sourceRange: { start: number; end: number },
  expansionStack: ExpansionFrame[] = []
): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  return blockstateUnit(idValue, namespace, createFenceBlockstateContent({
    post: `${id.namespace}:block/${id.path}_post`,
    side: `${id.namespace}:block/${id.path}_side`
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createFenceBlockstateContent(models: FenceBlockstateModels): Record<string, JsonValue> {
  const multipart: JsonValue[] = [
    { apply: { model: models.post } }
  ];
  facings.forEach((facing, index) => {
    const apply: Record<string, JsonValue> = { model: models.side };
    if (index > 0) {
      apply.y = index * 90;
    }
    if (index > 0) {
      apply.uvlock = true;
    }
    multipart.push({ when: { [facing]: true }, apply });
  });
  return { multipart };
}

export function createFenceGateBlockstate(
  idValue: string,
  namespace: string,
  sourceFile: string,
  sourceRange: { start: number; end: number },
  expansionStack: ExpansionFrame[] = []
): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  return blockstateUnit(idValue, namespace, createFenceGateBlockstateContent({
    base: `${id.namespace}:block/${id.path}`,
    open: `${id.namespace}:block/${id.path}_open`,
    wall: `${id.namespace}:block/${id.path}_wall`,
    wallOpen: `${id.namespace}:block/${id.path}_wall_open`
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createFenceGateBlockstateContent(models: FenceGateBlockstateModels): Record<string, JsonValue> {
  const variants: Record<string, JsonValue> = {};
  for (const facing of facings) {
    for (const inWall of [false, true]) {
      for (const open of [false, true]) {
        const entry: Record<string, JsonValue> = {
          model: fenceGateModel(models, inWall, open),
          uvlock: true
        };
        const y = fenceGateYaw[facing];
        if (y !== 0) {
          entry.y = y;
        }
        variants[`facing=${facing},in_wall=${inWall},open=${open}`] = entry;
      }
    }
  }
  return { variants };
}

export function createWallBlockstate(
  idValue: string,
  namespace: string,
  sourceFile: string,
  sourceRange: { start: number; end: number },
  expansionStack: ExpansionFrame[] = []
): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  return blockstateUnit(idValue, namespace, createWallBlockstateContent({
    post: `${id.namespace}:block/${id.path}_post`,
    side: `${id.namespace}:block/${id.path}_side`,
    sideTall: `${id.namespace}:block/${id.path}_side_tall`
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createWallBlockstateContent(models: WallBlockstateModels): Record<string, JsonValue> {
  const multipart: JsonValue[] = [
    { when: { up: true }, apply: { model: models.post } }
  ];
  facings.forEach((facing, index) => {
    for (const height of ["low", "tall"]) {
      const apply: Record<string, JsonValue> = { model: height === "tall" ? models.sideTall : models.side };
      if (index > 0) {
        apply.y = index * 90;
        apply.uvlock = true;
      }
      multipart.push({ when: { [facing]: height }, apply });
    }
  });
  return { multipart };
}

export function createCubeAllModel(
  idValue: string,
  textureValue: string | undefined,
  namespace: string,
  sourceFile: string,
  sourceRange: { start: number; end: number },
  expansionStack: ExpansionFrame[] = []
): ResourceUnit | null {
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
    sourceMap: sourceMap(resourceOutputPath("model", { namespace: id.namespace, path: `block/${id.path}` }), sourceFile, sourceRange, "builtin", expansionStack)
  };
}

export function createItemMapping(
  idValue: string,
  modelValue: string | undefined,
  namespace: string,
  sourceFile: string,
  sourceRange: { start: number; end: number },
  expansionStack: ExpansionFrame[] = []
): ResourceUnit | null {
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
    sourceMap: sourceMap(resourceOutputPath("item", id), sourceFile, sourceRange, "builtin", expansionStack)
  };
}

function blockstateUnit(
  idValue: string,
  namespace: string,
  content: JsonValue,
  sourceFile: string,
  sourceRange: { start: number; end: number },
  reason: "direct" | "builtin",
  expansionStack: ExpansionFrame[] = []
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
    sourceMap: sourceMap(outputPath, sourceFile, sourceRange, reason, expansionStack)
  };
}

function normalizeResourceValue(value: string, namespace: string, defaultFolder: string): string {
  if (value.includes(":")) {
    return value;
  }
  return `${namespace}:${value.includes("/") ? value : `${defaultFolder}/${value}`}`;
}

function stairsModelForShape(models: StairsBlockstateModels, shape: string): string {
  if (shape.startsWith("inner")) {
    return models.inner;
  }
  if (shape.startsWith("outer")) {
    return models.outer;
  }
  return models.base;
}

function fenceGateModel(models: FenceGateBlockstateModels, inWall: boolean, open: boolean): string {
  if (inWall) {
    return open ? models.wallOpen : models.wall;
  }
  return open ? models.open : models.base;
}

function sourceMap(
  outputPath: string,
  sourceFile: string,
  sourceRange: { start: number; end: number },
  reason: "direct" | "builtin",
  expansionStack: ExpansionFrame[] = []
) {
  return {
    generatedFile: outputPath,
    mappings: [{
      generatedPath: "",
      sourceFile,
      sourceRange,
      reason,
      expansionStack: reason === "builtin" ? [...expansionStack, { label: "builtin template", sourceRange }] : expansionStack
    }]
  };
}
