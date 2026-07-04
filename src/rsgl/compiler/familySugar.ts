import { ExprNode, SugarDeclNode, TextRange } from "../parser";
import { EvaluationContext, evaluateExpression } from "./evaluate";
import { ExpansionFrame, JsonValue, ResourceUnit, RsglMapping } from "./ir";
import { parseResourceId, resourceOutputPath } from "./resourceIds";
import {
  createButtonBlockstate,
  createDoorBlockstate,
  createFenceBlockstate,
  createFenceGateBlockstate,
  createItemMapping,
  createPressurePlateBlockstate,
  createSlabBlockstate,
  createSignBlockstate,
  createStairsBlockstate,
  createTrapdoorBlockstate,
  createWallSignBlockstate
} from "./templates";

type SupportedFamilyMember =
  | "planks"
  | "slab"
  | "stairs"
  | "fence"
  | "fence_gate"
  | "door"
  | "trapdoor"
  | "button"
  | "pressure_plate"
  | "sign";

export interface RsglFamilySugarOptions {
  onError?: (code: string, message: string, range: TextRange) => void;
}

interface FamilyContext {
  baseName: string;
  namespace: string;
  texture: string;
  sourceFile: string;
  sourceRange: TextRange;
  expansionStack: ExpansionFrame[];
}

export function compileFamilySugar(
  statement: SugarDeclNode,
  context: EvaluationContext,
  options: RsglFamilySugarOptions = {}
): ResourceUnit[] {
  const idValue = statement.id ? staticText(statement.id, context) : null;
  const id = idValue ? parseResourceId(idValue, context.namespace) : null;
  if (!id || !statement.id) {
    options.onError?.("rsgl.compileMissingResourceId", "Family sugar requires a static id.", statement.range);
    return [];
  }

  const family: FamilyContext = {
    baseName: id.path,
    namespace: id.namespace,
    texture: textureValue(statement, context, id.path),
    sourceFile: context.sourceFile ?? "<anonymous>",
    sourceRange: statement.range,
    expansionStack: [
      ...(context.expansionStack ?? []),
      { label: `${statement.sugarName.text} ${id.path}`, sourceRange: statement.range }
    ]
  };

  const units: ResourceUnit[] = [];
  for (const member of familyMembers(statement, context)) {
    if (isSupportedFamilyMember(member)) {
      units.push(...compileFamilyMember(member, family));
    } else {
      options.onError?.("rsgl.unsupportedFamilyMember", `Family member '${member}' is not supported yet.`, statement.range);
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

function familyMembers(statement: SugarDeclNode, context: EvaluationContext): string[] {
  const generateStatement = statement.body?.statements.find(item =>
    item.kind === "PropertyStmt" && item.name.text === "generate"
  );
  if (generateStatement?.kind === "PropertyStmt") {
    const value = evaluateExpression(generateStatement.value, context);
    return Array.isArray(value) ? value.map(item => String(item)) : [];
  }
  return ["planks"];
}

function textureValue(statement: SugarDeclNode, context: EvaluationContext, baseName: string): string {
  const textureStatement = statement.body?.statements.find(item =>
    item.kind === "PropertyStmt" && item.name.text === "texture"
  );
  const value = textureStatement?.kind === "PropertyStmt"
    ? evaluateExpression(textureStatement.value, context)
    : undefined;
  return typeof value === "string"
    ? normalizeResourceValue(value, context.namespace, "block")
    : `${context.namespace}:block/${baseName}_planks`;
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
    || value === "door"
    || value === "trapdoor"
    || value === "button"
    || value === "pressure_plate"
    || value === "sign";
}

function compact<T>(values: Array<T | null>): T[] {
  return values.filter((value): value is T => value !== null);
}
