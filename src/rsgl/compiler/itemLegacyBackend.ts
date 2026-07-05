import { JsonValue, ResourceId, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { isJsonObject } from "./jsonObjectMerge";
import { resourceOutputPath } from "./resourceIds";
import { RsglTargetPackFormat } from "./target";

export interface LowerItemUnitsForTargetResult {
  units: ResourceUnit[];
  diagnostics: RsglCompileDiagnostic[];
}

const modernItemModelPackFormat = 75;

export function lowerItemUnitsForTarget(
  units: ResourceUnit[],
  targetPackFormat: RsglTargetPackFormat | undefined
): LowerItemUnitsForTargetResult {
  if (!targetPackFormat || targetPackFormat.major >= modernItemModelPackFormat) {
    return { units, diagnostics: [] };
  }

  const diagnostics: RsglCompileDiagnostic[] = [];
  const modelOutputPaths = new Set(units
    .filter(unit => unit.kind === "model")
    .map(unit => normalizedPath(unit.outputPath)));
  const lowered = units.flatMap(unit => unit.kind === "item"
    ? lowerItemUnitToLegacy(unit, modelOutputPaths, diagnostics)
    : [unit]);
  return { units: lowered, diagnostics };
}

function lowerItemUnitToLegacy(
  unit: ResourceUnit,
  modelOutputPaths: Set<string>,
  diagnostics: RsglCompileDiagnostic[]
): ResourceUnit[] {
  if (!unit.id) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy item backend requires a static item id.");
    return [];
  }

  const content = isJsonObject(unit.content) ? unit.content : null;
  const model = isJsonObject(content?.model) ? content.model : null;
  if (!model) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy item backend requires an item model object.");
    return [];
  }

  const outputPath = legacyItemModelOutputPath(unit.id);
  const simpleModel = modelRef(model);
  if (simpleModel) {
    if (simpleModel === itemModelId(unit.id) && modelOutputPaths.has(normalizedPath(outputPath))) {
      return [];
    }
    return [legacyUnit(unit, outputPath, legacyBaseModel(unit.id, simpleModel))];
  }

  const lowered = lowerLegacyConditionalItemModel(unit.id, model, unit, diagnostics);
  return lowered ? [legacyUnit(unit, outputPath, lowered)] : [];
}

function lowerLegacyConditionalItemModel(
  itemId: ResourceId,
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): Record<string, JsonValue> | null {
  const type = itemModelType(model.type);
  if (type === "range_dispatch") {
    return lowerLegacyRangeDispatch(itemId, model, unit, diagnostics);
  }
  if (type === "select") {
    return lowerLegacySelect(itemId, model, unit, diagnostics);
  }
  if (type === "condition") {
    return lowerLegacyCondition(itemId, model, unit, diagnostics);
  }

  pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", `Legacy item backend does not support '${String(model.type)}' item models.`);
  return null;
}

function lowerLegacyRangeDispatch(
  itemId: ResourceId,
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): Record<string, JsonValue> | null {
  const predicate = rangePredicateName(model);
  const entries = Array.isArray(model.entries) ? model.entries : null;
  const fallback = isJsonObject(model.fallback) ? modelRef(model.fallback) : null;
  if (!predicate || !entries || !fallback) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy range_dispatch lowering requires a supported property, entries, and a model fallback.");
    return null;
  }

  const overrides: JsonValue[] = [];
  for (const entry of entries) {
    const entryObject = isJsonObject(entry) ? entry : null;
    const threshold = typeof entryObject?.threshold === "number" && Number.isFinite(entryObject.threshold)
      ? entryObject.threshold
      : null;
    const modelRefValue = isJsonObject(entryObject?.model) ? modelRef(entryObject.model) : null;
    if (threshold === null || !modelRefValue) {
      pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy range_dispatch entries must use finite thresholds and plain model branches.");
      return null;
    }
    overrides.push({
      predicate: { [predicate]: threshold },
      model: modelRefValue
    });
  }

  return withOverrides(legacyBaseModel(itemId, fallback), overrides);
}

function lowerLegacySelect(
  itemId: ResourceId,
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): Record<string, JsonValue> | null {
  if (normalizedProperty(model.property) !== "custom_model_data") {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy select lowering currently supports only custom_model_data cases.");
    return null;
  }

  const cases = Array.isArray(model.cases) ? model.cases : null;
  const fallback = isJsonObject(model.fallback) ? modelRef(model.fallback) : null;
  if (!cases || !fallback) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy select lowering requires cases and a model fallback.");
    return null;
  }

  const overrides: JsonValue[] = [];
  for (const itemCase of cases) {
    const caseObject = isJsonObject(itemCase) ? itemCase : null;
    const when = legacyNumericPredicateValue(caseObject?.when);
    const modelRefValue = isJsonObject(caseObject?.model) ? modelRef(caseObject.model) : null;
    if (when === null || !modelRefValue) {
      pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy select cases must use numeric custom_model_data values and plain model branches.");
      return null;
    }
    overrides.push({
      predicate: { ["custom_model_data"]: when },
      model: modelRefValue
    });
  }

  return withOverrides(legacyBaseModel(itemId, fallback), overrides);
}

function lowerLegacyCondition(
  itemId: ResourceId,
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): Record<string, JsonValue> | null {
  const predicate = conditionPredicateName(model);
  const onTrue = isJsonObject(model["on_true"]) ? modelRef(model["on_true"]) : null;
  const onFalse = isJsonObject(model["on_false"]) ? modelRef(model["on_false"]) : null;
  if (!predicate || !onTrue || !onFalse) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy condition lowering requires a supported property and plain model branches.");
    return null;
  }

  return withOverrides(legacyBaseModel(itemId, onFalse), [
    {
      predicate: { [predicate]: 1 },
      model: onTrue
    }
  ]);
}

function legacyBaseModel(itemId: ResourceId, model: string): Record<string, JsonValue> {
  if (model === itemModelId(itemId)) {
    return {
      parent: "minecraft:item/generated",
      textures: {
        layer0: model
      }
    };
  }
  return { parent: model };
}

function withOverrides(base: Record<string, JsonValue>, overrides: JsonValue[]): Record<string, JsonValue> {
  return overrides.length > 0
    ? { ...base, overrides }
    : base;
}

function legacyUnit(source: ResourceUnit, outputPath: string, content: Record<string, JsonValue>): ResourceUnit {
  return {
    ...source,
    kind: "model",
    outputPath,
    content,
    sourceMap: {
      ...source.sourceMap,
      generatedFile: outputPath
    }
  };
}

function modelRef(model: Record<string, JsonValue>): string | null {
  return itemModelType(model.type) === "model" && typeof model.model === "string"
    ? model.model
    : null;
}

function itemModelType(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.replace(/^minecraft:/, "") : "";
}

function rangePredicateName(model: Record<string, JsonValue>): string | null {
  const property = normalizedProperty(model.property);
  if (!property) {
    return null;
  }
  if (property === "custom_model_data") {
    return "custom_model_data";
  }
  if (property === "damage" || property === "damaged" || property === "pull" || property === "pulling" || property === "blocking" || property === "cooldown") {
    return property;
  }
  if (property === "compass") {
    return "angle";
  }
  if (property === "time") {
    return "time";
  }
  return null;
}

function conditionPredicateName(model: Record<string, JsonValue>): string | null {
  const property = normalizedProperty(model.property);
  if (property === "using_item") {
    return "pulling";
  }
  if (property === "blocking" || property === "damaged" || property === "broken") {
    return property;
  }
  return null;
}

function normalizedProperty(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value.replace(/^minecraft:/, "") : null;
}

function legacyNumericPredicateValue(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }
  return null;
}

function itemModelId(id: ResourceId): string {
  return `${id.namespace}:item/${id.path}`;
}

function legacyItemModelOutputPath(id: ResourceId): string {
  return resourceOutputPath("model", { namespace: id.namespace, path: `item/${id.path}` });
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function pushLegacyDiagnostic(
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  code: string,
  message: string
): void {
  diagnostics.push({
    code,
    message,
    severity: "error",
    range: unit.sourceMap.mappings[0]?.sourceRange ?? { start: 0, end: 1 },
    fileName: unit.sourceMap.mappings[0]?.sourceFile
  });
}
