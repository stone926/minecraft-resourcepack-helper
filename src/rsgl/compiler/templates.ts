/* eslint-disable @typescript-eslint/naming-convention */
import { ExpansionFrame, JsonValue, ResourceUnit } from "./ir";
import { blockstateVariantKey } from "./blockstateKeys";
import { parseResourceId, resourceOutputPath } from "./resourceIds";

const facings = ["north", "east", "south", "west"] as const;
type Facing = typeof facings[number];
const halves = ["bottom", "top"] as const;
const shapes = ["straight", "inner_left", "inner_right", "outer_left", "outer_right"] as const;
const buttonFaces = ["ceiling", "floor", "wall"] as const;
type ButtonFace = typeof buttonFaces[number];

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

export interface DoorBlockstateModels {
  bottomLeft: string;
  bottomLeftOpen: string;
  bottomRight: string;
  bottomRightOpen: string;
  topLeft: string;
  topLeftOpen: string;
  topRight: string;
  topRightOpen: string;
}

export interface TrapdoorBlockstateModels {
  bottom: string;
  top: string;
  open: string;
}

export interface ButtonBlockstateModels {
  base: string;
  pressed: string;
}

export interface PressurePlateBlockstateModels {
  up: string;
  down: string;
}

export interface SignBlockstateModels {
  rotations: [string, string, string, string];
}

export interface HangingSignBlockstateModels {
  rotations: [string, string, string, string];
  attachedRotations: [string, string, string, string];
}

export interface WallSignBlockstateModels {
  model: string;
}

export interface WallBlockstateModels {
  post: string;
  side: string;
  sideTall: string;
}

export interface PaneBlockstateModels {
  post: string;
  side: string;
  sideAlt: string;
  noSide: string;
  noSideAlt: string;
}

export interface HorizontalFacingBlockstateOptions {
  model: string;
  state?: Record<string, JsonValue>;
  uvlock?: boolean;
}

export interface AxisRotatedBlockstateModels {
  vertical: string;
  horizontal: string;
  state?: Record<string, JsonValue>;
  uvlock?: boolean;
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

const horizontalFacingYaw: Record<string, number> = {
  north: 0,
  east: 90,
  south: 180,
  west: 270
};

const doorClosedYaw: Record<string, number> = {
  north: 270,
  east: 0,
  south: 90,
  west: 180
};

const doorOpenLeftYaw: Record<string, number> = {
  north: 0,
  east: 90,
  south: 180,
  west: 270
};

const doorOpenRightYaw: Record<string, number> = {
  north: 180,
  east: 270,
  south: 0,
  west: 90
};

const trapdoorClosedYaw: Record<string, number> = {
  north: 0,
  east: 90,
  south: 180,
  west: 270
};

const trapdoorTopOpenYaw: Record<string, number> = {
  north: 180,
  east: 270,
  south: 0,
  west: 90
};

const buttonYaw: Record<ButtonFace, Record<Facing, number>> = {
  ceiling: { north: 180, east: 270, south: 0, west: 90 },
  floor: { north: 0, east: 90, south: 180, west: 270 },
  wall: { north: 0, east: 90, south: 180, west: 270 }
};

const wallSignYaw: Record<Facing, number> = {
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
  expansionStack: ExpansionFrame[] = [],
  models?: StairsBlockstateModels
): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  return blockstateUnit(idValue, namespace, createStairsBlockstateContent(models ?? {
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

export function createDoorBlockstate(
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
  return blockstateUnit(idValue, namespace, createDoorBlockstateContent({
    bottomLeft: `${id.namespace}:block/${id.path}_bottom_left`,
    bottomLeftOpen: `${id.namespace}:block/${id.path}_bottom_left_open`,
    bottomRight: `${id.namespace}:block/${id.path}_bottom_right`,
    bottomRightOpen: `${id.namespace}:block/${id.path}_bottom_right_open`,
    topLeft: `${id.namespace}:block/${id.path}_top_left`,
    topLeftOpen: `${id.namespace}:block/${id.path}_top_left_open`,
    topRight: `${id.namespace}:block/${id.path}_top_right`,
    topRightOpen: `${id.namespace}:block/${id.path}_top_right_open`
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createDoorBlockstateContent(models: DoorBlockstateModels): Record<string, JsonValue> {
  const variants: Record<string, JsonValue> = {};
  for (const facing of facings) {
    for (const half of ["lower", "upper"] as const) {
      for (const hinge of ["left", "right"] as const) {
        for (const open of [false, true]) {
          const entry: Record<string, JsonValue> = {
            model: doorModel(models, half, hinge, open)
          };
          const y = doorYaw(facing, hinge, open);
          if (y !== 0) {
            entry.y = y;
          }
          variants[`facing=${facing},half=${half},hinge=${hinge},open=${open}`] = entry;
        }
      }
    }
  }
  return { variants };
}

export function createTrapdoorBlockstate(
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
  return blockstateUnit(idValue, namespace, createTrapdoorBlockstateContent({
    bottom: `${id.namespace}:block/${id.path}_bottom`,
    top: `${id.namespace}:block/${id.path}_top`,
    open: `${id.namespace}:block/${id.path}_open`
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createTrapdoorBlockstateContent(models: TrapdoorBlockstateModels): Record<string, JsonValue> {
  const variants: Record<string, JsonValue> = {};
  for (const facing of facings) {
    for (const half of halves) {
      for (const open of [false, true]) {
        const entry: Record<string, JsonValue> = {
          model: open ? models.open : (half === "top" ? models.top : models.bottom)
        };
        if (open && half === "top") {
          entry.x = 180;
        }
        const y = open && half === "top" ? trapdoorTopOpenYaw[facing] : trapdoorClosedYaw[facing];
        if (y !== 0) {
          entry.y = y;
        }
        variants[`facing=${facing},half=${half},open=${open}`] = entry;
      }
    }
  }
  return { variants };
}

export function createButtonBlockstate(
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
  return blockstateUnit(idValue, namespace, createButtonBlockstateContent({
    base: `${id.namespace}:block/${id.path}`,
    pressed: `${id.namespace}:block/${id.path}_pressed`
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createButtonBlockstateContent(models: ButtonBlockstateModels): Record<string, JsonValue> {
  const variants: Record<string, JsonValue> = {};
  for (const face of buttonFaces) {
    for (const facing of facings) {
      for (const powered of [false, true]) {
        const entry: Record<string, JsonValue> = {
          model: powered ? models.pressed : models.base
        };
        if (face === "ceiling") {
          entry.x = 180;
        } else if (face === "wall") {
          entry.x = 90;
          entry.uvlock = true;
        }
        const y = buttonYaw[face][facing];
        if (y !== 0) {
          entry.y = y;
        }
        variants[`face=${face},facing=${facing},powered=${powered}`] = entry;
      }
    }
  }
  return { variants };
}

export function createPressurePlateBlockstate(
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
  return blockstateUnit(idValue, namespace, createPressurePlateBlockstateContent({
    up: `${id.namespace}:block/${id.path}`,
    down: `${id.namespace}:block/${id.path}_down`
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createPressurePlateBlockstateContent(models: PressurePlateBlockstateModels): Record<string, JsonValue> {
  return {
    variants: {
      "powered=false": { model: models.up },
      "powered=true": { model: models.down }
    }
  };
}

export function createSignBlockstate(
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
  return blockstateUnit(idValue, namespace, createSignBlockstateContent({
    rotations: [
      `${id.namespace}:block/${id.path}_rot_0`,
      `${id.namespace}:block/${id.path}_rot_1`,
      `${id.namespace}:block/${id.path}_rot_2`,
      `${id.namespace}:block/${id.path}_rot_3`
    ]
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createSignBlockstateContent(models: SignBlockstateModels): Record<string, JsonValue> {
  const variants: Record<string, JsonValue> = {};
  for (let rotation = 0; rotation < 16; rotation += 1) {
    const entry: Record<string, JsonValue> = {
      model: models.rotations[rotation % models.rotations.length]
    };
    const y = Math.floor(rotation / models.rotations.length) * 90;
    if (y !== 0) {
      entry.y = y;
    }
    variants[`rotation=${rotation}`] = entry;
  }
  return { variants };
}

export function createHangingSignBlockstate(
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
  return blockstateUnit(idValue, namespace, createHangingSignBlockstateContent({
    rotations: [
      `${id.namespace}:block/${id.path}_rot_0`,
      `${id.namespace}:block/${id.path}_rot_1`,
      `${id.namespace}:block/${id.path}_rot_2`,
      `${id.namespace}:block/${id.path}_rot_3`
    ],
    attachedRotations: [
      `${id.namespace}:block/${id.path}_attached_rot_0`,
      `${id.namespace}:block/${id.path}_attached_rot_1`,
      `${id.namespace}:block/${id.path}_attached_rot_2`,
      `${id.namespace}:block/${id.path}_attached_rot_3`
    ]
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createHangingSignBlockstateContent(models: HangingSignBlockstateModels): Record<string, JsonValue> {
  const variants: Record<string, JsonValue> = {};
  for (const attached of [false, true]) {
    const rotations = attached ? models.attachedRotations : models.rotations;
    for (let rotation = 0; rotation < 16; rotation += 1) {
      const entry: Record<string, JsonValue> = {
        model: rotations[rotation % rotations.length]
      };
      const y = Math.floor(rotation / rotations.length) * 90;
      if (y !== 0) {
        entry.y = y;
      }
      variants[`attached=${attached},rotation=${rotation}`] = entry;
    }
  }
  return { variants };
}

export function createWallSignBlockstate(
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
  return blockstateUnit(idValue, namespace, createWallSignBlockstateContent({
    model: `${id.namespace}:block/${id.path}`
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createWallSignBlockstateContent(models: WallSignBlockstateModels): Record<string, JsonValue> {
  const variants: Record<string, JsonValue> = {};
  for (const facing of facings) {
    const entry: Record<string, JsonValue> = {
      model: models.model
    };
    const y = wallSignYaw[facing];
    if (y !== 0) {
      entry.y = y;
    }
    variants[`facing=${facing}`] = entry;
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

export function createPaneBlockstate(
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
  return blockstateUnit(idValue, namespace, createPaneBlockstateContent({
    post: `${id.namespace}:block/${id.path}_post`,
    side: `${id.namespace}:block/${id.path}_side`,
    sideAlt: `${id.namespace}:block/${id.path}_side_alt`,
    noSide: `${id.namespace}:block/${id.path}_noside`,
    noSideAlt: `${id.namespace}:block/${id.path}_noside_alt`
  }), sourceFile, sourceRange, "builtin", expansionStack);
}

export function createPaneBlockstateContent(models: PaneBlockstateModels): Record<string, JsonValue> {
  const multipart: JsonValue[] = [
    { apply: { model: models.post } },
    { when: { north: true }, apply: { model: models.side } },
    { when: { east: true }, apply: { model: models.side, y: 90 } },
    { when: { south: true }, apply: { model: models.sideAlt } },
    { when: { west: true }, apply: { model: models.sideAlt, y: 90 } },
    { when: { north: false }, apply: { model: models.noSide } },
    { when: { east: false }, apply: { model: models.noSideAlt } },
    { when: { south: false }, apply: { model: models.noSideAlt, y: 90 } },
    { when: { west: false }, apply: { model: models.noSide, y: 270 } }
  ];
  return { multipart };
}

export function createHorizontalFacingBlockstateContent(options: HorizontalFacingBlockstateOptions): Record<string, JsonValue> {
  const variants: Record<string, JsonValue> = {};
  for (const facing of facings) {
    const entry: Record<string, JsonValue> = { model: options.model };
    const y = horizontalFacingYaw[facing];
    if (y !== 0) {
      entry.y = y;
    }
    if (options.uvlock && y !== 0) {
      entry.uvlock = true;
    }
    variants[blockstateVariantKey({ ...(options.state ?? {}), facing })] = entry;
  }
  return { variants };
}

export function createAxisRotatedBlockstateContent(models: AxisRotatedBlockstateModels): Record<string, JsonValue> {
  const variants: Record<string, JsonValue> = {
    [blockstateVariantKey({ ...(models.state ?? {}), axis: "x" })]: rotatedAxisEntry(models.horizontal, 90, 90, models.uvlock),
    [blockstateVariantKey({ ...(models.state ?? {}), axis: "y" })]: { model: models.vertical },
    [blockstateVariantKey({ ...(models.state ?? {}), axis: "z" })]: rotatedAxisEntry(models.horizontal, 90, 0, models.uvlock)
  };
  return { variants };
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

export function createGeneratedItemModel(
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
  const modelId = { namespace: id.namespace, path: `item/${id.path}` };
  const outputPath = resourceOutputPath("model", modelId);
  const texture = textureValue ? normalizeResourceValue(textureValue, namespace, "item") : `${id.namespace}:item/${id.path}`;
  return {
    id: modelId,
    kind: "model",
    outputPath,
    content: {
      parent: "minecraft:item/generated",
      textures: {
        layer0: texture
      }
    },
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: sourceMap(outputPath, sourceFile, sourceRange, "builtin", expansionStack)
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

function doorModel(models: DoorBlockstateModels, half: "lower" | "upper", hinge: "left" | "right", open: boolean): string {
  if (half === "lower" && hinge === "left") {
    return open ? models.bottomLeftOpen : models.bottomLeft;
  }
  if (half === "lower") {
    return open ? models.bottomRightOpen : models.bottomRight;
  }
  if (hinge === "left") {
    return open ? models.topLeftOpen : models.topLeft;
  }
  return open ? models.topRightOpen : models.topRight;
}

function doorYaw(facing: string, hinge: "left" | "right", open: boolean): number {
  if (!open) {
    return doorClosedYaw[facing];
  }
  return hinge === "left" ? doorOpenLeftYaw[facing] : doorOpenRightYaw[facing];
}

function rotatedAxisEntry(model: string, x: number, y: number, uvlock: boolean | undefined): Record<string, JsonValue> {
  const entry: Record<string, JsonValue> = { model };
  if (x !== 0) {
    entry.x = x;
  }
  if (y !== 0) {
    entry.y = y;
  }
  if (uvlock) {
    entry.uvlock = true;
  }
  return entry;
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
