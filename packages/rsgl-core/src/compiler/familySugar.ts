import { ArgumentNode, CallExprNode, ExprNode, TextRange } from "../parser";
import { EvaluationContext, evaluateExpression } from "./evaluate";
import { ExpansionFrame, JsonValue, ResourceId, ResourceUnit, RsglMapping } from "./ir";
import { parseResourceId, resourceOutputPath } from "./resourceIds";
import {
  createButtonBlockstate,
  createDoorBlockstate,
  createFenceBlockstate,
  createFenceGateBlockstate,
  createHangingSignBlockstate,
  createItemMapping,
  createPaneBlockstate,
  createPressurePlateBlockstate,
  createSlabBlockstate,
  createSignBlockstate,
  createStairsBlockstate,
  createTrapdoorBlockstate,
  createWallBlockstate,
  createWallSignBlockstate
} from "./templates";

type SupportedFamilyMember =
  | "planks"
  | "slab"
  | "stairs"
  | "fence"
  | "fence_gate"
  | "wall"
  | "pane"
  | "door"
  | "trapdoor"
  | "button"
  | "pressure_plate"
  | "sign"
  | "hanging_sign"
  | "boat"
  | "chest_boat";

export interface RsglFamilySugarOptions {
  onError?: (code: string, message: string, range: TextRange) => void;
}

interface FamilyContext {
  baseName: string;
  namespace: string;
  texture: string;
  hangingSignParticle: string;
  sourceFile: string;
  sourceRange: TextRange;
  expansionStack: ExpansionFrame[];
}

export function compileBlockFamilyUse(
  call: CallExprNode,
  context: EvaluationContext,
  options: RsglFamilySugarOptions = {}
): ResourceUnit[] {
  const base = requiredResourceArgument(call, "base", 0, context, options);
  if (!base) {
    return [];
  }

  const texture = optionalResourceArgument(call, "texture", 1, context, "block")
    ?? `${base.namespace}:block/${base.path}_planks`;
  const hangingSignParticle = optionalResourceArgument(call, "hangingSignParticle", 4, context, "block")
    ?? optionalResourceArgument(call, "hanging_sign_particle", -1, context, "block")
    ?? defaultHangingSignParticle(base.namespace, base.path);
  const members = blockFamilyMembers(call, context, options);
  const family: FamilyContext = {
    baseName: base.path,
    namespace: base.namespace,
    texture,
    hangingSignParticle,
    sourceFile: context.sourceFile ?? "<anonymous>",
    sourceRange: call.range,
    expansionStack: [
      ...(context.expansionStack ?? []),
      { label: `blockFamily ${base.path}`, sourceRange: call.range }
    ]
  };
  const units = compileFamilyMembers(members, family, options);
  return blockFamilyItemModels(call, context) ? units : units.filter(unit => !isFamilyItemUnit(unit));
}

function compileFamilyMembers(
  members: string[],
  family: FamilyContext,
  options: RsglFamilySugarOptions
): ResourceUnit[] {
  const units: ResourceUnit[] = [];
  for (const member of members) {
    if (isSupportedFamilyMember(member)) {
      units.push(...compileFamilyMember(member, family));
    } else {
      options.onError?.("rsgl.unsupportedFamilyMember", `Family member '${member}' is not supported yet.`, family.sourceRange);
    }
  }
  return units;
}

function compileFamilyMember(member: SupportedFamilyMember, family: FamilyContext): ResourceUnit[] {
  if (member === "planks") {
    return compact([
      createCubeModel(family, `${family.baseName}_planks`, "minecraft:block/cube_all", { all: family.texture }),
      createSingleVariantBlockstate(family, `${family.baseName}_planks`, `${family.namespace}:block/${family.baseName}_planks`),
      createItemMapping(`${family.namespace}:${family.baseName}_planks`, `${family.namespace}:block/${family.baseName}_planks`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  if (member === "slab") {
    const id = `${family.baseName}_slab`;
    return compact([
      createCubeModel(family, id, "minecraft:block/slab", slabTextures(family.texture)),
      createCubeModel(family, `${id}_top`, "minecraft:block/slab_top", slabTextures(family.texture)),
      createSlabBlockstate(`${family.namespace}:${id}`, `${family.namespace}:block/${family.baseName}_planks`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:block/${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  if (member === "stairs") {
    const id = `${family.baseName}_stairs`;
    return compact([
      createCubeModel(family, id, "minecraft:block/stairs", slabTextures(family.texture)),
      createCubeModel(family, `${id}_inner`, "minecraft:block/inner_stairs", slabTextures(family.texture)),
      createCubeModel(family, `${id}_outer`, "minecraft:block/outer_stairs", slabTextures(family.texture)),
      createStairsBlockstate(`${family.namespace}:${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:block/${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  if (member === "fence") {
    const id = `${family.baseName}_fence`;
    return compact([
      createCubeModel(family, `${id}_post`, "minecraft:block/fence_post", { texture: family.texture }),
      createCubeModel(family, `${id}_side`, "minecraft:block/fence_side", { texture: family.texture }),
      createCubeModel(family, `${id}_inventory`, "minecraft:block/fence_inventory", { texture: family.texture }),
      createFenceBlockstate(`${family.namespace}:${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:block/${id}_inventory`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  if (member === "wall") {
    const id = `${family.baseName}_wall`;
    const textures = { wall: family.texture };
    return compact([
      createCubeModel(family, `${id}_post`, "minecraft:block/template_wall_post", textures),
      createCubeModel(family, `${id}_side`, "minecraft:block/template_wall_side", textures),
      createCubeModel(family, `${id}_side_tall`, "minecraft:block/template_wall_side_tall", textures),
      createCubeModel(family, `${id}_inventory`, "minecraft:block/wall_inventory", textures),
      createWallBlockstate(`${family.namespace}:${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:block/${id}_inventory`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  if (member === "pane") {
    const id = `${family.baseName}_pane`;
    const textures = { pane: family.texture, edge: family.texture };
    return compact([
      createCubeModel(family, `${id}_post`, "minecraft:block/template_glass_pane_post", textures),
      createCubeModel(family, `${id}_side`, "minecraft:block/template_glass_pane_side", textures),
      createCubeModel(family, `${id}_side_alt`, "minecraft:block/template_glass_pane_side_alt", textures),
      createCubeModel(family, `${id}_noside`, "minecraft:block/template_glass_pane_noside", textures),
      createCubeModel(family, `${id}_noside_alt`, "minecraft:block/template_glass_pane_noside_alt", textures),
      createPaneBlockstate(`${family.namespace}:${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:block/${id}_noside`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  if (member === "door") {
    const id = `${family.baseName}_door`;
    const textures = doorTextures(family);
    return compact([
      createCubeModel(family, `${id}_bottom_left`, "minecraft:block/door_bottom_left", textures),
      createCubeModel(family, `${id}_bottom_left_open`, "minecraft:block/door_bottom_left_open", textures),
      createCubeModel(family, `${id}_bottom_right`, "minecraft:block/door_bottom_right", textures),
      createCubeModel(family, `${id}_bottom_right_open`, "minecraft:block/door_bottom_right_open", textures),
      createCubeModel(family, `${id}_top_left`, "minecraft:block/door_top_left", textures),
      createCubeModel(family, `${id}_top_left_open`, "minecraft:block/door_top_left_open", textures),
      createCubeModel(family, `${id}_top_right`, "minecraft:block/door_top_right", textures),
      createCubeModel(family, `${id}_top_right_open`, "minecraft:block/door_top_right_open", textures),
      createDoorBlockstate(`${family.namespace}:${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createItemModel(family, id, "minecraft:item/generated", { layer0: `${family.namespace}:item/${id}` }),
      createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:item/${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  if (member === "trapdoor") {
    const id = `${family.baseName}_trapdoor`;
    const textures = { texture: `${family.namespace}:block/${id}` };
    return compact([
      createCubeModel(family, `${id}_bottom`, "minecraft:block/template_orientable_trapdoor_bottom", textures),
      createCubeModel(family, `${id}_top`, "minecraft:block/template_orientable_trapdoor_top", textures),
      createCubeModel(family, `${id}_open`, "minecraft:block/template_orientable_trapdoor_open", textures),
      createTrapdoorBlockstate(`${family.namespace}:${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:block/${id}_bottom`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  if (member === "button") {
    const id = `${family.baseName}_button`;
    const textures = { texture: family.texture };
    return compact([
      createCubeModel(family, id, "minecraft:block/button", textures),
      createCubeModel(family, `${id}_pressed`, "minecraft:block/button_pressed", textures),
      createCubeModel(family, `${id}_inventory`, "minecraft:block/button_inventory", textures),
      createButtonBlockstate(`${family.namespace}:${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:block/${id}_inventory`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  if (member === "pressure_plate") {
    const id = `${family.baseName}_pressure_plate`;
    const textures = { texture: family.texture };
    return compact([
      createCubeModel(family, id, "minecraft:block/pressure_plate_up", textures),
      createCubeModel(family, `${id}_down`, "minecraft:block/pressure_plate_down", textures),
      createPressurePlateBlockstate(`${family.namespace}:${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:block/${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  if (member === "sign") {
    const id = `${family.baseName}_sign`;
    const wallId = `${family.baseName}_wall_sign`;
    const textures = signTextures(family, id);
    return compact([
      createCubeModel(family, `${id}_rot_0`, "minecraft:block/template_sign_rot_0", textures),
      createCubeModel(family, `${id}_rot_1`, "minecraft:block/template_sign_rot_1", textures),
      createCubeModel(family, `${id}_rot_2`, "minecraft:block/template_sign_rot_2", textures),
      createCubeModel(family, `${id}_rot_3`, "minecraft:block/template_sign_rot_3", textures),
      createCubeModel(family, wallId, "minecraft:block/template_wall_sign", textures),
      createSignBlockstate(`${family.namespace}:${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createWallSignBlockstate(`${family.namespace}:${wallId}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createItemModel(family, id, "minecraft:item/generated", { layer0: `${family.namespace}:item/${id}` }),
      createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:item/${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  if (member === "hanging_sign") {
    const id = `${family.baseName}_hanging_sign`;
    const wallId = `${family.baseName}_wall_hanging_sign`;
    const textures = hangingSignTextures(family, id);
    return compact([
      createCubeModel(family, `${id}_rot_0`, "minecraft:block/template_hanging_sign_rot_0", textures),
      createCubeModel(family, `${id}_rot_1`, "minecraft:block/template_hanging_sign_rot_1", textures),
      createCubeModel(family, `${id}_rot_2`, "minecraft:block/template_hanging_sign_rot_2", textures),
      createCubeModel(family, `${id}_rot_3`, "minecraft:block/template_hanging_sign_rot_3", textures),
      createCubeModel(family, `${id}_attached_rot_0`, "minecraft:block/template_attached_hanging_sign_rot_0", textures),
      createCubeModel(family, `${id}_attached_rot_1`, "minecraft:block/template_attached_hanging_sign_rot_1", textures),
      createCubeModel(family, `${id}_attached_rot_2`, "minecraft:block/template_attached_hanging_sign_rot_2", textures),
      createCubeModel(family, `${id}_attached_rot_3`, "minecraft:block/template_attached_hanging_sign_rot_3", textures),
      createCubeModel(family, wallId, "minecraft:block/template_wall_hanging_sign", textures),
      createHangingSignBlockstate(`${family.namespace}:${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createWallSignBlockstate(`${family.namespace}:${wallId}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
      createItemModel(family, id, "minecraft:item/generated", { layer0: `${family.namespace}:item/${id}` }),
      createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:item/${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  if (member === "boat" || member === "chest_boat") {
    const id = member === "boat" ? `${family.baseName}_boat` : `${family.baseName}_chest_boat`;
    return compact([
      createItemModel(family, id, "minecraft:item/generated", { layer0: `${family.namespace}:item/${id}` }),
      createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:item/${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
    ]);
  }

  const id = `${family.baseName}_fence_gate`;
  return compact([
    createCubeModel(family, id, "minecraft:block/template_fence_gate", { texture: family.texture }),
    createCubeModel(family, `${id}_open`, "minecraft:block/template_fence_gate_open", { texture: family.texture }),
    createCubeModel(family, `${id}_wall`, "minecraft:block/template_fence_gate_wall", { texture: family.texture }),
    createCubeModel(family, `${id}_wall_open`, "minecraft:block/template_fence_gate_wall_open", { texture: family.texture }),
    createFenceGateBlockstate(`${family.namespace}:${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
    createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:block/${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
  ]);
}

function createCubeModel(
  family: FamilyContext,
  path: string,
  parent: string,
  textures: Record<string, JsonValue>
): ResourceUnit | null {
  const id = parseResourceId(`${family.namespace}:${path}`, family.namespace);
  if (!id) {
    return null;
  }
  const modelId = { namespace: id.namespace, path: `block/${id.path}` };
  const outputPath = resourceOutputPath("model", modelId);
  return {
    id: modelId,
    kind: "model",
    outputPath,
    content: { parent, textures },
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: familySourceMap(outputPath, family)
  };
}

function createSingleVariantBlockstate(
  family: FamilyContext,
  path: string,
  model: string
): ResourceUnit | null {
  const id = parseResourceId(`${family.namespace}:${path}`, family.namespace);
  if (!id) {
    return null;
  }
  const outputPath = resourceOutputPath("blockstate", id);
  const defaultVariantKey = "";
  return {
    id,
    kind: "blockstate",
    outputPath,
    content: {
      variants: {
        [defaultVariantKey]: { model }
      }
    },
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: familySourceMap(outputPath, family)
  };
}

function blockFamilyMembers(
  call: CallExprNode,
  context: EvaluationContext,
  options: RsglFamilySugarOptions
): string[] {
  const variants = findArgument(call, "variants", 2);
  if (!variants) {
    return ["planks"];
  }
  const value = evaluateExpression(variants.value, context);
  if (!Array.isArray(value)) {
    options.onError?.("rsgl.invalidBuiltinUseArgument", "blockFamily variants must evaluate to a list.", variants.value.range);
    return [];
  }
  return value.map(item => normalizeFamilyMember(String(item)));
}

function normalizeFamilyMember(value: string): string {
  if (value === "cube" || value === "cube_all") {
    return "planks";
  }
  return value;
}

function blockFamilyItemModels(call: CallExprNode, context: EvaluationContext): boolean {
  const itemModels = findArgument(call, "itemModels", 3);
  if (!itemModels) {
    return true;
  }
  return evaluateExpression(itemModels.value, context) !== false;
}

function requiredResourceArgument(
  call: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext,
  options: RsglFamilySugarOptions
): ResourceId | null {
  const argument = findArgument(call, name, positionalIndex);
  if (!argument) {
    options.onError?.("rsgl.compileMissingArgument", `Missing blockFamily argument '${name}'.`, call.range);
    return null;
  }
  const value = staticText(argument.value, context);
  const id = value ? parseResourceId(value, context.namespace) : null;
  if (!id) {
    options.onError?.("rsgl.compileMissingResourceId", `blockFamily argument '${name}' must be a static resource id.`, argument.value.range);
    return null;
  }
  return id;
}

function optionalResourceArgument(
  call: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext,
  defaultFolder: string
): string | null {
  const argument = findArgument(call, name, positionalIndex);
  const value = argument ? staticText(argument.value, context) : null;
  return value ? normalizeResourceValue(value, context.namespace, defaultFolder) : null;
}

function findArgument(call: CallExprNode, name: string, positionalIndex: number): ArgumentNode | undefined {
  return call.args.find(arg => arg.name?.text === name)
    ?? call.args.filter(arg => !arg.name)[positionalIndex];
}

function slabTextures(texture: string): Record<string, JsonValue> {
  return {
    bottom: texture,
    top: texture,
    side: texture
  };
}

function doorTextures(family: FamilyContext): Record<string, JsonValue> {
  return {
    bottom: `${family.namespace}:block/${family.baseName}_door_bottom`,
    top: `${family.namespace}:block/${family.baseName}_door_top`
  };
}

function signTextures(family: FamilyContext, id: string): Record<string, JsonValue> {
  return {
    all: `${family.namespace}:block/${id}`,
    particle: family.texture
  };
}

function hangingSignTextures(family: FamilyContext, id: string): Record<string, JsonValue> {
  return {
    all: `${family.namespace}:block/${id}`,
    particle: family.hangingSignParticle
  };
}

function defaultHangingSignParticle(namespace: string, baseName: string): string {
  if (baseName === "bamboo") {
    return `${namespace}:block/bamboo_planks`;
  }
  if (baseName === "crimson" || baseName === "warped") {
    return `${namespace}:block/stripped_${baseName}_stem`;
  }
  return `${namespace}:block/stripped_${baseName}_log`;
}

function createItemModel(
  family: FamilyContext,
  path: string,
  parent: string,
  textures: Record<string, JsonValue>
): ResourceUnit | null {
  const id = parseResourceId(`${family.namespace}:${path}`, family.namespace);
  if (!id) {
    return null;
  }
  const modelId = { namespace: id.namespace, path: `item/${id.path}` };
  const outputPath = resourceOutputPath("model", modelId);
  return {
    id: modelId,
    kind: "model",
    outputPath,
    content: { parent, textures },
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: familySourceMap(outputPath, family)
  };
}

function familySourceMap(outputPath: string, family: FamilyContext) {
  const mapping: RsglMapping = {
    generatedPath: "",
    sourceFile: family.sourceFile,
    sourceRange: family.sourceRange,
    reason: "builtin",
    expansionStack: family.expansionStack
  };
  return {
    generatedFile: outputPath,
    mappings: [mapping]
  };
}

function staticText(expression: ExprNode, context: EvaluationContext): string | null {
  const value = evaluateExpression(expression, context);
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

function normalizeResourceValue(value: string, namespace: string, defaultFolder: string): string {
  if (value.includes(":")) {
    return value;
  }
  return `${namespace}:${value.includes("/") ? value : `${defaultFolder}/${value}`}`;
}

function isSupportedFamilyMember(value: string): value is SupportedFamilyMember {
  return value === "planks"
    || value === "slab"
    || value === "stairs"
    || value === "fence"
    || value === "fence_gate"
    || value === "wall"
    || value === "pane"
    || value === "door"
    || value === "trapdoor"
    || value === "button"
    || value === "pressure_plate"
    || value === "sign"
    || value === "hanging_sign"
    || value === "boat"
    || value === "chest_boat";
}

function isFamilyItemUnit(unit: ResourceUnit): boolean {
  return unit.kind === "item" || (unit.kind === "model" && unit.id?.path.startsWith("item/") === true);
}

function compact<T>(values: Array<T | null>): T[] {
  return values.filter((value): value is T => value !== null);
}
