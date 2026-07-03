import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";

export interface RsglResourceValidationOptions {
  targetPackFormat?: { major: number; minor?: number };
  resourceExists?: (kind: "model" | "texture", id: string) => boolean;
}

export function validateResourceUnits(
  units: ResourceUnit[],
  options: RsglResourceValidationOptions = {}
): RsglCompileDiagnostic[] {
  const diagnostics: RsglCompileDiagnostic[] = [];
  const generatedModels = new Set(
    units
      .filter(unit => unit.kind === "model" && unit.id)
      .map(unit => `${unit.id!.namespace}:${unit.id!.path}`)
  );

  for (const unit of units) {
    if (unit.kind === "model") {
      validateModelUnit(unit, generatedModels, options, diagnostics);
    } else if (unit.kind === "blockstate") {
      validateBlockstateUnit(unit, generatedModels, options, diagnostics);
    }
  }

  return diagnostics;
}

function validateModelUnit(
  unit: ResourceUnit,
  generatedModels: Set<string>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  const parent = content ? content.parent : undefined;
  if (typeof parent === "string") {
    checkResourceExists("model", parent, unit, generatedModels, options, diagnostics);
  }

  const textures = asObject(content?.textures);
  if (textures) {
    for (const value of Object.values(textures)) {
      if (typeof value === "string" && !value.startsWith("#")) {
        checkResourceExists("texture", value, unit, generatedModels, options, diagnostics);
      } else if (isObject(value) && typeof value.sprite === "string" && !value.sprite.startsWith("#")) {
        checkResourceExists("texture", value.sprite, unit, generatedModels, options, diagnostics);
      }
    }
  }
}

function validateBlockstateUnit(
  unit: ResourceUnit,
  generatedModels: Set<string>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  visitJson(unit.content, value => {
    if (!isObject(value)) {
      return;
    }
    if (typeof value.model === "string") {
      checkResourceExists("model", value.model, unit, generatedModels, options, diagnostics);
    }
    if ("z" in value && options.targetPackFormat && options.targetPackFormat.major < 75) {
      diagnostics.push({
        code: "rsgl.unsupportedBlockstateZRotation",
        message: "Blockstate z rotation requires pack format 75.0 or newer.",
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
    if ("weight" in value && (!Number.isInteger(value.weight) || Number(value.weight) <= 0)) {
      diagnostics.push({
        code: "rsgl.invalidRandomWeight",
        message: "Random model weight must be a positive integer.",
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
  });
}

function checkResourceExists(
  kind: "model" | "texture",
  id: string,
  unit: ResourceUnit,
  generatedModels: Set<string>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (kind === "model" && generatedModels.has(id)) {
    return;
  }
  if (!options.resourceExists || options.resourceExists(kind, id)) {
    return;
  }

  diagnostics.push({
    code: kind === "model" ? "rsgl.modelNotFound" : "rsgl.textureNotFound",
    message: `${kind === "model" ? "Model" : "Texture"} not found: ${id}`,
    severity: "warning",
    range: unit.sourceMap.mappings[0].sourceRange
  });
}

function visitJson(value: JsonValue, visitor: (value: JsonValue) => void): void {
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach(item => visitJson(item, visitor));
  } else if (isObject(value)) {
    Object.values(value).forEach(item => visitJson(item as JsonValue, visitor));
  }
}

function asObject(value: unknown): Record<string, JsonValue> | null {
  return isObject(value) ? value as Record<string, JsonValue> : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
