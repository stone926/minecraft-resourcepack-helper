import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import { checkJsonResourceReference } from "./jsonResourceReferenceValidation";
import { getItemSpecialTextureConsumer } from "./resourceReferenceConsumers";
import { pushUnitDiagnostic } from "./validationDiagnostics";
import {
  requireArray,
  requireEnum,
  requireNumberInRange,
  requireObject,
  requireString,
  stripMinecraftPrefix
} from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";

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
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const basePath = appendGeneratedPath(generatedPath, "base");
  const specialModelPath = appendGeneratedPath(generatedPath, "model");
  if (typeof model.base === "string") {
    checkJsonResourceReference(
      model,
      "base",
      "model",
      unit,
      options,
      diagnostics,
      basePath
    );
  } else {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemSpecialBase", "Item special model must define a base model id.", "error", basePath);
  }

  const specialModel = requireObject(model.model, unit, diagnostics, {
    code: "rsgl.invalidItemSpecialModel",
    message: "Item special model must define a model object.",
    generatedPath: specialModelPath
  });
  if (!specialModel) {
    return;
  }

  validateSpecialModelShape(specialModel, unit, diagnostics, specialModelPath);
  const texture = typeof specialModel.texture === "string" ? specialModel.texture : null;
  if (texture !== null) {
    const consumer = getItemSpecialTextureConsumer(stripMinecraftPrefix(specialModel.type));
    if (consumer) {
      checkJsonResourceReference(
        specialModel,
        "texture",
        consumer,
        unit,
        options,
        diagnostics,
        appendGeneratedPath(specialModelPath, "texture")
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
  const tints = requireArray(model.tints, unit, diagnostics, {
    code: "rsgl.invalidItemTints",
    message: "Item model tints must be an array.",
    generatedPath: tintsPath
  });
  if (!tints) {
    return;
  }

  for (const [index, tint] of tints.entries()) {
    const tintPath = appendGeneratedPath(tintsPath, String(index));
    const tintObject = requireObject(tint, unit, diagnostics, {
      code: "rsgl.invalidItemTint",
      message: "Item tint must define a known tint type.",
      generatedPath: tintPath
    });
    if (!tintObject) {
      continue;
    }
    const type = stripMinecraftPrefix(tintObject.type);
    const requiredFields = type ? itemTintRequiredFields.get(type) : undefined;
    if (!type || !requiredFields) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemTint", "Item tint must define a known tint type.", "error", tintPath);
      continue;
    }
    for (const field of requiredFields) {
      if (!(field in tintObject)) {
        pushUnitDiagnostic(diagnostics, unit, "rsgl.missingItemTintField", `Item tint '${type}' must define '${field}'.`, "error", tintPath);
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
  const type = stripMinecraftPrefix(specialModel.type);
  const requiredFields = type ? specialModelRequiredFields.get(type) : undefined;
  if (!type || !requiredFields) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemSpecialModelType", "Item special model must define a known special model type.", "error", typePath);
    return;
  }

  for (const field of requiredFields) {
    if (!(field in specialModel)) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.missingItemSpecialModelField", `Item special model '${type}' must define '${field}'.`, "error", typePath);
    }
  }

  for (const { field, values } of specialModelEnumFields.get(type) ?? []) {
    const value = specialModel[field];
    if (value !== undefined) {
      requireEnum(value, values, unit, diagnostics, {
        code: "rsgl.invalidItemSpecialModelField",
        message: `Item special model '${type}' field '${field}' has an invalid value.`,
        generatedPath: appendGeneratedPath(generatedPath, field)
      });
    }
  }

  for (const field of specialModelStringFields.get(type) ?? []) {
    if (field in specialModel) {
      requireString(specialModel[field], unit, diagnostics, {
        code: "rsgl.invalidItemSpecialModelField",
        message: `Field '${field}' must be a string.`,
        generatedPath: appendGeneratedPath(generatedPath, field)
      });
    }
  }

  validateNumberFieldInRange(specialModel, "page1", 0, 1, "rsgl.invalidItemSpecialModelField", unit, diagnostics, generatedPath);
  validateNumberFieldInRange(specialModel, "page2", 0, 1, "rsgl.invalidItemSpecialModelField", unit, diagnostics, generatedPath);
  validateNumberFieldInRange(specialModel, "openness", 0, 1, "rsgl.invalidItemSpecialModelField", unit, diagnostics, generatedPath);
  validateNumberFieldInRange(specialModel, "animation", -Infinity, Infinity, "rsgl.invalidItemSpecialModelField", unit, diagnostics, generatedPath);
  if ("open_angle" in specialModel && !Number.isInteger(specialModel.open_angle)) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidItemSpecialModelField",
      "Item special model 'book' field 'open_angle' must be an integer.",
      "error",
      appendGeneratedPath(generatedPath, "open_angle")
    );
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
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.invalidItemTintColor",
        `Item tint '${type}' field '${field}' must be a packed color integer or RGB triplet.`,
        "error",
        appendGeneratedPath(generatedPath, field)
      );
    }
  }
  validateNumberFieldInRange(tint, "temperature", 0, 1, "rsgl.invalidItemTintField", unit, diagnostics, generatedPath);
  validateNumberFieldInRange(tint, "downfall", 0, 1, "rsgl.invalidItemTintField", unit, diagnostics, generatedPath);
  if ("index" in tint && (!Number.isInteger(tint.index) || Number(tint.index) < 0)) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidItemTintField",
      `Item tint '${type}' field 'index' must be a non-negative integer.`,
      "error",
      appendGeneratedPath(generatedPath, "index")
    );
  }
}

function validateNumberFieldInRange(
  object: Record<string, JsonValue>,
  field: string,
  min: number,
  max: number,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (!(field in object)) {
    return;
  }
  requireNumberInRange(object[field], min, max, unit, diagnostics, {
    code,
    message: `Field '${field}' must be a number${Number.isFinite(min) && Number.isFinite(max) ? ` between ${min} and ${max}` : ""}.`,
    generatedPath: appendGeneratedPath(generatedPath, field)
  });
}

function isColorValue(value: JsonValue | undefined): boolean {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 0 && value <= 0xffffff;
  }
  return Array.isArray(value)
    && value.length === 3
    && value.every(item => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1);
}
