import { validateBlockstateStateDomains } from "./blockstateStateValidation";
import { blockstateMultipartPath, blockstateVariantPath } from "./compilerHelpers";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import { pushDiagnosticAtRange, sourceRangeForGeneratedPath } from "./validationDiagnostics";
import { asObject } from "./validationPrimitives";
import { checkJsonResourceReference } from "./jsonResourceReferenceValidation";
import {
  analyzeBlockstateVariantSelectors,
  type BlockstateVariantSelectorAnalysis
} from "./blockstateVariantSelectors";
import type {
  RsglBlockstateSchema,
  RsglResourceValidationOptions,
  ValidationRange
} from "./validationTypes";

export function validateBlockstateUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  const blockstateSchema = unit.id ? options.blockstateSchema?.(unit.id) : undefined;
  validateBlockstateStateDomains(content ?? undefined, unit, diagnostics, {
    rangeForGeneratedPath: path => sourceRangeForGeneratedPath(unit, path),
    schema: blockstateSchema
  });
  if (content && "variants" in content && "multipart" in content) {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.blockstateModeConflict",
      "A blockstate root cannot contain both 'variants' and 'multipart'.",
      "error",
      sourceRangeForGeneratedPath(unit, "")
    );
  }
  const variants = asObject(content?.variants);
  if (content && "variants" in content && !variants) {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.invalidBlockstateVariantsRoot",
      "Blockstate root field 'variants' must be an object.",
      "error",
      sourceRangeForGeneratedPath(unit, "/variants")
    );
  }
  if (variants) {
    for (const [key, value] of Object.entries(variants)) {
      const generatedPath = blockstateVariantPath(key);
      const range = sourceRangeForGeneratedPath(unit, generatedPath);
      validateBlockstateVariantKey(key, diagnostics, range);
      validateBlockstateModelProps(value, unit, options, diagnostics, range, generatedPath);
    }
    const selectorAnalysis = analyzeBlockstateVariantSelectors(Object.keys(variants));
    validateVariantOverlap(selectorAnalysis, unit, diagnostics);
    validateVariantExhaustiveness(selectorAnalysis, blockstateSchema, unit, diagnostics);
  }

  const multipart = Array.isArray(content?.multipart) ? content.multipart : [];
  if (content && "multipart" in content && !Array.isArray(content.multipart)) {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.invalidBlockstateMultipartRoot",
      "Blockstate root field 'multipart' must be an array.",
      "error",
      sourceRangeForGeneratedPath(unit, "/multipart")
    );
  }
  for (const [index, entry] of multipart.entries()) {
    const multipartEntry = asObject(entry);
    const generatedPath = blockstateMultipartPath(index);
    const range = sourceRangeForGeneratedPath(unit, generatedPath);
    if (!multipartEntry) {
      pushDiagnosticAtRange(
        diagnostics,
        "rsgl.invalidBlockstateMultipartEntry",
        "A blockstate multipart entry must be an object containing 'apply'.",
        "error",
        range
      );
      continue;
    }
    validateBlockstateWhen(multipartEntry?.when, diagnostics, range);
    validateBlockstateModelProps(
      multipartEntry?.apply,
      unit,
      options,
      diagnostics,
      range,
      appendGeneratedPath(generatedPath, "apply")
    );
  }
  validateDuplicateMultipartPredicates(multipart, unit, diagnostics);
}

function validateVariantOverlap(
  analysis: BlockstateVariantSelectorAnalysis,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  for (const [key, overlappingKey] of analysis.overlaps) {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.overlappingBlockstateVariantEntry",
      `Blockstate variant '${key || "*"}' overlaps '${overlappingKey || "*"}'; variants cases must select disjoint state sets.`,
      "error",
      sourceRangeForGeneratedPath(unit, blockstateVariantPath(key))
    );
  }
}

function validateVariantExhaustiveness(
  analysis: BlockstateVariantSelectorAnalysis,
  schema: RsglBlockstateSchema | null | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!schema || Object.keys(schema.properties).length === 0) {
    return;
  }
  if (analysis.overlaps.size > 0) {
    return;
  }

  const schemaEntries = Object.entries(schema.properties);
  const total = schemaEntries.reduce(
    (product, [, values]) => product * BigInt(values.length),
    1n
  );
  let covered = 0n;
  for (const selector of analysis.selectors) {
    if ([...selector.assignments].some(([name, value]) =>
      !Object.hasOwn(schema.properties, name)
      || !schema.properties[name]?.includes(value)
    )) {
      continue;
    }
    covered += schemaEntries.reduce(
      (product, [name, values]) => product * BigInt(
        selector.assignments.has(name) ? 1 : values.length
      ),
      1n
    );
  }
  if (covered >= total) {
    return;
  }
  pushDiagnosticAtRange(
    diagnostics,
    "rsgl.incompleteBlockstateVariants",
    `Blockstate variants leave ${total - covered} of ${total} schema state combinations uncovered.`,
    "warning",
    sourceRangeForGeneratedPath(unit, "/variants")
  );
}

function validateDuplicateMultipartPredicates(
  multipart: JsonValue[],
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const firstByPredicate = new Map<string, number>();
  for (const [index, rawEntry] of multipart.entries()) {
    const entry = asObject(rawEntry);
    if (!entry || entry.when === undefined || Array.isArray(entry.apply) || !asObject(entry.apply)) {
      continue;
    }
    const key = canonicalCondition(entry.when);
    const earlier = firstByPredicate.get(key);
    if (earlier === undefined) {
      firstByPredicate.set(key, index);
      continue;
    }
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.duplicateMultipartPredicateHint",
      `Multipart parts ${earlier + 1} and ${index + 1} use the same predicate with single models; if one model should be selected at random, put both options in one random choice.`,
      "info",
      sourceRangeForGeneratedPath(unit, blockstateMultipartPath(index))
    );
  }
}

function canonicalCondition(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCondition).sort().join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${
        key === "AND" || key === "OR"
          ? canonicalCondition(item)
          : canonicalConditionValue(item)
      }`)
      .join(",")}}`;
  }
  return canonicalConditionValue(value);
}

function canonicalConditionValue(value: JsonValue): string {
  if (typeof value === "string" && value.includes("|")) {
    return JSON.stringify(value.split("|").sort().join("|"));
  }
  return JSON.stringify(value);
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
      pushDiagnosticAtRange(
        diagnostics,
        "rsgl.invalidBlockstateVariantKey",
        `Blockstate variant key '${key}' must use comma-separated state=value pairs.`,
        "error",
        range
      );
      continue;
    }
    if (seen.has(stateName)) {
      pushDiagnosticAtRange(
        diagnostics,
        "rsgl.duplicateBlockstateVariantProperty",
        `Blockstate variant key '${key}' defines '${stateName}' more than once.`,
        "error",
        range
      );
    }
    seen.add(stateName);
  }
}

function validateBlockstateModelProps(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange,
  generatedPath: string
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      pushDiagnosticAtRange(
        diagnostics,
        "rsgl.emptyBlockstateModelList",
        "A blockstate model list must contain at least one model object.",
        "error",
        sourceRangeForGeneratedPath(unit, generatedPath)
      );
      return;
    }
    for (const [index, item] of value.entries()) {
      const itemPath = appendGeneratedPath(generatedPath, String(index));
      if (Array.isArray(item)) {
        pushDiagnosticAtRange(
          diagnostics,
          "rsgl.nestedBlockstateModelList",
          "Blockstate model lists must be flat.",
          "error",
          sourceRangeForGeneratedPath(unit, itemPath)
        );
      } else {
        validateBlockstateModelObject(item, unit, options, diagnostics, range, itemPath, true);
      }
    }
    return;
  }

  validateBlockstateModelObject(value, unit, options, diagnostics, range, generatedPath, false);
}

function validateBlockstateModelObject(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange,
  generatedPath: string,
  allowWeight: boolean
): void {
  const model = asObject(value);
  if (!model) {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.missingBlockstateModel",
      "A blockstate model value must be an object containing a valid 'model' field.",
      "error",
      sourceRangeForGeneratedPath(unit, generatedPath)
    );
    return;
  }
  if (typeof model.model === "string") {
    checkJsonResourceReference(
      model,
      "model",
      "model",
      unit,
      options,
      diagnostics,
      appendGeneratedPath(generatedPath, "model")
    );
  } else {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.missingBlockstateModel",
      "A blockstate model object must contain a valid ModelId in its 'model' field.",
      "error",
      sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "model"))
    );
  }
  for (const axis of ["x", "y", "z"]) {
    validateBlockstateRotation(
      axis,
      model[axis],
      diagnostics,
      sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, axis))
    );
  }
  if ("z" in model && options.targetPackFormat && options.targetPackFormat.major < 75) {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.unsupportedBlockstateZRotation",
      "Blockstate z rotation requires pack format 75.0 or newer.",
      "error",
      sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "z"))
    );
  }
  if ("uvlock" in model && typeof model.uvlock !== "boolean") {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.invalidBlockstateUvlock",
      "Blockstate model uvlock must be a boolean.",
      "error",
      sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "uvlock"))
    );
  }
  if ("weight" in model && !allowWeight) {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.blockstateWeightInvalidContext",
      "weight is only valid on an option inside a random blockstate choice.",
      "error",
      sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "weight"))
    );
  } else if ("weight" in model && (!Number.isInteger(model.weight) || Number(model.weight) <= 0)) {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.invalidRandomWeight",
      "Random model weight must be a positive integer.",
      "error",
      sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "weight"))
    );
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
  pushDiagnosticAtRange(
    diagnostics,
    "rsgl.invalidBlockstateRotation",
    `Blockstate model ${axis} rotation must be one of 0, 90, 180, or 270.`,
    "error",
    range
  );
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
      pushDiagnosticAtRange(diagnostics, "rsgl.emptyBlockstateWhen", "Blockstate multipart when array must contain at least one condition.", "error", range);
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
    pushDiagnosticAtRange(diagnostics, "rsgl.invalidBlockstateWhen", "Blockstate multipart when condition must be a non-empty object.", "error", range);
    return;
  }

  const logicalKeys = ["OR", "AND"].filter(key => key in condition);
  if (logicalKeys.length > 0 && Object.keys(condition).some(key => key !== "OR" && key !== "AND")) {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.mixedBlockstateWhenCondition",
      "Blockstate multipart OR/AND conditions cannot be mixed with state properties in the same condition object.",
      "error",
      range
    );
  }

  for (const key of logicalKeys) {
    const nested = condition[key];
    if (!Array.isArray(nested) || nested.length === 0) {
      pushDiagnosticAtRange(
        diagnostics,
        "rsgl.invalidBlockstateLogicalCondition",
        `Blockstate multipart ${key} condition must be a non-empty condition array.`,
        "error",
        range
      );
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
  pushDiagnosticAtRange(
    diagnostics,
    "rsgl.invalidBlockstateWhenValue",
    "Blockstate multipart when values must be boolean, number, or a non-empty string list separated by '|'.",
    "error",
    range
  );
}
