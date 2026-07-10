import { validateBlockstateStateDomains } from "./blockstateStateValidation";
import { blockstateMultipartPath, blockstateVariantPath } from "./compilerHelpers";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import {
  asObject,
  checkResourceExists,
  sourceRangeForGeneratedPath,
  type RsglResourceValidationOptions,
  type ValidationRange
} from "./validationShared";

export function validateBlockstateUnit(
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  validateBlockstateStateDomains(content ?? undefined, unit, diagnostics, {
    rangeForGeneratedPath: path => sourceRangeForGeneratedPath(unit, path),
    schema: unit.id ? options.blockstateSchema?.(unit.id) : undefined
  });
  const variants = asObject(content?.variants);
  if (variants) {
    for (const [key, value] of Object.entries(variants)) {
      const generatedPath = blockstateVariantPath(key);
      const range = sourceRangeForGeneratedPath(unit, generatedPath);
      validateBlockstateVariantKey(key, diagnostics, range);
      validateBlockstateModelProps(value, unit, generatedModels, options, diagnostics, range, generatedPath);
    }
  }

  const multipart = Array.isArray(content?.multipart) ? content.multipart : [];
  for (const [index, entry] of multipart.entries()) {
    const multipartEntry = asObject(entry);
    const generatedPath = blockstateMultipartPath(index);
    const range = sourceRangeForGeneratedPath(unit, generatedPath);
    validateBlockstateWhen(multipartEntry?.when, diagnostics, range);
    validateBlockstateModelProps(
      multipartEntry?.apply,
      unit,
      generatedModels,
      options,
      diagnostics,
      range,
      appendGeneratedPath(generatedPath, "apply")
    );
  }
}

function validateBlockstateVariantKey(
  key: string,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
): void {
  if (key === "") {
    return;
  }
  const seen = new Set<string>();
  for (const part of key.split(",")) {
    const separatorIndex = part.indexOf("=");
    const stateName = separatorIndex >= 0 ? part.slice(0, separatorIndex) : "";
    const stateValue = separatorIndex >= 0 ? part.slice(separatorIndex + 1) : "";
    if (!stateName || !stateValue || separatorIndex !== part.lastIndexOf("=")) {
      diagnostics.push({
        code: "rsgl.invalidBlockstateVariantKey",
        message: `Blockstate variant key '${key}' must use comma-separated state=value pairs.`,
        severity: "error",
        range
      });
      continue;
    }
    if (seen.has(stateName)) {
      diagnostics.push({
        code: "rsgl.duplicateBlockstateVariantProperty",
        message: `Blockstate variant key '${key}' defines '${stateName}' more than once.`,
        severity: "error",
        range
      });
    }
    seen.add(stateName);
  }
}

function validateBlockstateModelProps(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange,
  generatedPath: string
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateBlockstateModelProps(
        item,
        unit,
        generatedModels,
        options,
        diagnostics,
        range,
        appendGeneratedPath(generatedPath, String(index))
      );
    }
    return;
  }

  const model = asObject(value);
  if (!model) {
    return;
  }
  if (typeof model.model === "string") {
    checkResourceExists(
      "model",
      model.model,
      unit,
      generatedModels,
      options,
      diagnostics,
      sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "model"))
    );
  }
  for (const axis of ["x", "y", "z"]) {
    validateBlockstateRotation(axis, model[axis], diagnostics, range);
  }
  if ("z" in model && options.targetPackFormat && options.targetPackFormat.major < 75) {
    diagnostics.push({
      code: "rsgl.unsupportedBlockstateZRotation",
      message: "Blockstate z rotation requires pack format 75.0 or newer.",
      severity: "error",
      range
    });
  }
  if ("uvlock" in model && typeof model.uvlock !== "boolean") {
    diagnostics.push({
      code: "rsgl.invalidBlockstateUvlock",
      message: "Blockstate model uvlock must be a boolean.",
      severity: "error",
      range
    });
  }
  if ("weight" in model && (!Number.isInteger(model.weight) || Number(model.weight) <= 0)) {
    diagnostics.push({
      code: "rsgl.invalidRandomWeight",
      message: "Random model weight must be a positive integer.",
      severity: "error",
      range
    });
  }
}

function validateBlockstateRotation(
  axis: string,
  value: JsonValue | undefined,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
): void {
  if (value === undefined || value === 0 || value === 90 || value === 180 || value === 270) {
    return;
  }
  diagnostics.push({
    code: "rsgl.invalidBlockstateRotation",
    message: `Blockstate model ${axis} rotation must be one of 0, 90, 180, or 270.`,
    severity: "error",
    range
  });
}

function validateBlockstateWhen(
  value: JsonValue | undefined,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
): void {
  if (value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      diagnostics.push({
        code: "rsgl.emptyBlockstateWhen",
        message: "Blockstate multipart when array must contain at least one condition.",
        severity: "error",
        range
      });
    }
    for (const item of value) {
      validateBlockstateCondition(item, diagnostics, range);
    }
    return;
  }
  validateBlockstateCondition(value, diagnostics, range);
}

function validateBlockstateCondition(
  value: JsonValue | undefined,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
): void {
  const condition = asObject(value);
  if (!condition || Object.keys(condition).length === 0) {
    diagnostics.push({
      code: "rsgl.invalidBlockstateWhen",
      message: "Blockstate multipart when condition must be a non-empty object.",
      severity: "error",
      range
    });
    return;
  }

  const logicalKeys = ["OR", "AND"].filter(key => key in condition);
  if (logicalKeys.length > 0 && Object.keys(condition).some(key => key !== "OR" && key !== "AND")) {
    diagnostics.push({
      code: "rsgl.mixedBlockstateWhenCondition",
      message: "Blockstate multipart OR/AND conditions cannot be mixed with state properties in the same condition object.",
      severity: "error",
      range
    });
  }

  for (const key of logicalKeys) {
    const nested = condition[key];
    if (!Array.isArray(nested) || nested.length === 0) {
      diagnostics.push({
        code: "rsgl.invalidBlockstateLogicalCondition",
        message: `Blockstate multipart ${key} condition must be a non-empty condition array.`,
        severity: "error",
        range
      });
      continue;
    }
    for (const item of nested) {
      validateBlockstateCondition(item, diagnostics, range);
    }
  }

  for (const [key, item] of Object.entries(condition)) {
    if (key === "OR" || key === "AND") {
      continue;
    }
    validateBlockstateConditionValue(item, diagnostics, range);
  }
}

function validateBlockstateConditionValue(
  value: JsonValue,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
): void {
  if (typeof value === "boolean" || typeof value === "number") {
    return;
  }
  if (typeof value === "string" && /^!?[^|]+(?:\|!?[^|]+)*$/.test(value)) {
    return;
  }
  diagnostics.push({
    code: "rsgl.invalidBlockstateWhenValue",
    message: "Blockstate multipart when values must be boolean, number, or a non-empty string list separated by '|'.",
    severity: "error",
    range
  });
}
