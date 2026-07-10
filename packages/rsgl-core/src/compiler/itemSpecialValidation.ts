import {
  minecraftResourceIdInFolder,
  qualifyMinecraftResourceId,
  tryParseMinecraftResourceId
} from "../../../mc-assets/src";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import {
  asObject,
  checkResourceExists,
  itemModelType,
  sourceRangeForGeneratedPath,
  type RsglResourceValidationOptions
} from "./validationShared";

const specialModelRequiredFields = new Map<string, string[]>([
  ["banner", ["color"]],
  ["bell", []],
  ["book", ["open_angle", "page1", "page2"]],
  ["chest", ["texture"]],
  ["conduit", []],
  ["copper_golem_statue", ["pose", "texture"]],
  ["decorated_pot", []],
  ["end_cube", ["effect"]],
  ["head", ["kind"]],
  ["player_head", []],
  ["shield", []],
  ["shulker_box", ["texture"]],
  ["trident", []]
]);

const specialModelEnumFields = new Map<string, Array<{ field: string; values: string[] }>>([
  ["banner", [
    { field: "attachment", values: ["ground", "wall"] },
    { field: "color", values: ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"] }
  ]],
  ["chest", [
    { field: "chest_type", values: ["single", "left", "right"] }
  ]],
  ["copper_golem_statue", [
    { field: "pose", values: ["standing", "sitting", "running", "star"] }
  ]],
  ["end_cube", [
    { field: "effect", values: ["gateway", "portal"] }
  ]],
  ["head", [
    { field: "kind", values: ["skeleton", "wither_skeleton", "player", "zombie", "creeper", "piglin", "dragon"] }
  ]]
]);

const specialModelStringFields = new Map<string, string[]>([
  ["chest", ["texture"]],
  ["copper_golem_statue", ["texture"]],
  ["head", ["texture"]],
  ["shulker_box", ["texture"]]
]);

const itemTintRequiredFields = new Map<string, string[]>([
  ["constant", ["value"]],
  ["dye", ["default"]],
  ["firework", ["default"]],
  ["grass", ["temperature", "downfall"]],
  ["map_color", ["default"]],
  ["potion", ["default"]],
  ["team", ["default"]],
  ["custom_model_data", ["default"]]
]);

export function validateItemSpecial(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const basePath = appendGeneratedPath(generatedPath, "base");
  const specialModelPath = appendGeneratedPath(generatedPath, "model");
  if (typeof model.base === "string") {
    checkResourceExists("model", model.base, unit, generatedModels, options, diagnostics, sourceRangeForGeneratedPath(unit, basePath));
  } else {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialBase",
      message: "Item special model must define a base model id.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, basePath)
    });
  }

  const specialModel = asObject(model.model);
  if (!specialModel) {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModel",
      message: "Item special model must define a model object.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, specialModelPath)
    });
    return;
  }

  validateSpecialModelShape(specialModel, unit, diagnostics, specialModelPath);
  const texture = typeof specialModel.texture === "string" ? specialModel.texture : null;
  if (texture) {
    const target = itemSpecialTextureId(itemModelType(specialModel.type), texture, unit.id?.namespace ?? "minecraft");
    if (target) {
      checkResourceExists(
        "texture",
        target,
        unit,
        generatedModels,
        options,
        diagnostics,
        sourceRangeForGeneratedPath(unit, appendGeneratedPath(specialModelPath, "texture"))
      );
    }
  }
}

export function validateItemTints(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (!("tints" in model)) {
    return;
  }
  const tintsPath = appendGeneratedPath(generatedPath, "tints");
  if (!Array.isArray(model.tints)) {
    diagnostics.push({
      code: "rsgl.invalidItemTints",
      message: "Item model tints must be an array.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, tintsPath)
    });
    return;
  }

  for (const [index, tint] of model.tints.entries()) {
    const tintPath = appendGeneratedPath(tintsPath, String(index));
    const tintObject = asObject(tint);
    const type = itemModelType(tintObject?.type);
    const requiredFields = type ? itemTintRequiredFields.get(type) : undefined;
    if (!tintObject || !type || !requiredFields) {
      diagnostics.push({
        code: "rsgl.invalidItemTint",
        message: "Item tint must define a known tint type.",
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, tintPath)
      });
      continue;
    }
    for (const field of requiredFields) {
      if (!(field in tintObject)) {
        diagnostics.push({
          code: "rsgl.missingItemTintField",
          message: `Item tint '${type}' must define '${field}'.`,
          severity: "error",
          range: sourceRangeForGeneratedPath(unit, tintPath)
        });
      }
    }
    validateTintValue(tintObject, type, unit, diagnostics, tintPath);
  }
}

function validateSpecialModelShape(
  specialModel: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const typePath = appendGeneratedPath(generatedPath, "type");
  const type = itemModelType(specialModel.type);
  const requiredFields = type ? specialModelRequiredFields.get(type) : undefined;
  if (!type || !requiredFields) {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModelType",
      message: "Item special model must define a known special model type.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, typePath)
    });
    return;
  }

  for (const field of requiredFields) {
    if (!(field in specialModel)) {
      diagnostics.push({
        code: "rsgl.missingItemSpecialModelField",
        message: `Item special model '${type}' must define '${field}'.`,
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, typePath)
      });
    }
  }

  for (const { field, values } of specialModelEnumFields.get(type) ?? []) {
    const value = specialModel[field];
    if (value !== undefined && (typeof value !== "string" || !values.includes(value))) {
      diagnostics.push({
        code: "rsgl.invalidItemSpecialModelField",
        message: `Item special model '${type}' field '${field}' has an invalid value.`,
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field))
      });
    }
  }

  for (const field of specialModelStringFields.get(type) ?? []) {
    validateSpecialStringField(specialModel, field, unit, diagnostics, generatedPath);
  }

  validateSpecialNumberInRange(specialModel, "page1", 0, 1, unit, diagnostics, generatedPath);
  validateSpecialNumberInRange(specialModel, "page2", 0, 1, unit, diagnostics, generatedPath);
  validateSpecialNumberInRange(specialModel, "openness", 0, 1, unit, diagnostics, generatedPath);
  validateSpecialNumberInRange(specialModel, "animation", -Infinity, Infinity, unit, diagnostics, generatedPath);
  if ("open_angle" in specialModel && !Number.isInteger(specialModel.open_angle)) {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModelField",
      message: "Item special model 'book' field 'open_angle' must be an integer.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "open_angle"))
    });
  }
}

function validateSpecialStringField(
  object: Record<string, JsonValue>,
  field: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (field in object && typeof object[field] !== "string") {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModelField",
      message: `Field '${field}' must be a string.`,
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field))
    });
  }
}

function validateSpecialNumberInRange(
  object: Record<string, JsonValue>,
  field: string,
  min: number,
  max: number,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const value = object[field];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModelField",
      message: `Field '${field}' must be a number${Number.isFinite(min) && Number.isFinite(max) ? ` between ${min} and ${max}` : ""}.`,
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field))
    });
  }
}

function validateTintValue(
  tint: Record<string, JsonValue>,
  type: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  for (const field of ["value", "default"]) {
    if (field in tint && !isColorValue(tint[field])) {
      diagnostics.push({
        code: "rsgl.invalidItemTintColor",
        message: `Item tint '${type}' field '${field}' must be a packed color integer or RGB triplet.`,
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field))
      });
    }
  }
  validateNumberInRange(tint, "temperature", 0, 1, "rsgl.invalidItemTintField", unit, diagnostics, generatedPath);
  validateNumberInRange(tint, "downfall", 0, 1, "rsgl.invalidItemTintField", unit, diagnostics, generatedPath);
  if ("index" in tint && (!Number.isInteger(tint.index) || Number(tint.index) < 0)) {
    diagnostics.push({
      code: "rsgl.invalidItemTintField",
      message: `Item tint '${type}' field 'index' must be a non-negative integer.`,
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "index"))
    });
  }
}

function validateNumberInRange(
  object: Record<string, JsonValue>,
  field: string,
  min: number,
  max: number,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const value = object[field];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    diagnostics.push({
      code,
      message: `Field '${field}' must be a number${Number.isFinite(min) && Number.isFinite(max) ? ` between ${min} and ${max}` : ""}.`,
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field))
    });
  }
}

function isColorValue(value: JsonValue | undefined): boolean {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 0 && value <= 0xffffff;
  }
  return Array.isArray(value)
    && value.length === 3
    && value.every(item => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1);
}

function itemSpecialTextureId(type: string | null, texture: string, defaultNamespace: string): string | null {
  if (type === "chest") {
    return minecraftResourceIdInFolder(texture, defaultNamespace, "entity/chest");
  }
  if (type === "shulker_box") {
    return minecraftResourceIdInFolder(texture, defaultNamespace, "entity/shulker");
  }
  if (type === "head") {
    return minecraftResourceIdInFolder(texture, defaultNamespace, "entity");
  }
  if (type === "copper_golem_statue") {
    const id = tryParseMinecraftResourceId(texture, defaultNamespace);
    return id ? `${id.namespace}:${id.path.replace(/^textures\//, "").replace(/\.png$/, "")}` : qualifyMinecraftResourceId(texture, defaultNamespace);
  }
  return null;
}
