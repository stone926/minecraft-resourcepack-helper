import { ExprNode, SugarDeclNode, TextRange } from "../parser";
import { EvaluationContext, evaluateExpression } from "./evaluate";
import { ExpansionFrame, JsonValue, ResourceUnit, RsglMapping } from "./ir";
import { parseResourceId, resourceOutputPath } from "./resourceIds";
import {
  createFenceBlockstate,
  createItemMapping,
  createSlabBlockstate,
  createStairsBlockstate
} from "./templates";

type SupportedFamilyMember = "planks" | "slab" | "stairs" | "fence";

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

  const id = `${family.baseName}_fence`;
  return compact([
    createCubeModel(family, `${id}_post`, "minecraft:block/fence_post", { texture: family.texture }),
    createCubeModel(family, `${id}_side`, "minecraft:block/fence_side", { texture: family.texture }),
    createCubeModel(family, `${id}_inventory`, "minecraft:block/fence_inventory", { texture: family.texture }),
    createFenceBlockstate(`${family.namespace}:${id}`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack),
    createItemMapping(`${family.namespace}:${id}`, `${family.namespace}:block/${id}_inventory`, family.namespace, family.sourceFile, family.sourceRange, family.expansionStack)
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
    : `${context.namespace}:block/${baseName}`;
}

function slabTextures(texture: string): Record<string, JsonValue> {
  return {
    bottom: texture,
    top: texture,
    side: texture
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
  return value === "planks" || value === "slab" || value === "stairs" || value === "fence";
}

function compact<T>(values: Array<T | null>): T[] {
  return values.filter((value): value is T => value !== null);
}
