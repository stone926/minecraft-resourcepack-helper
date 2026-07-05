import { JsonValue, ResourceId, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { isJsonObject } from "./jsonObjectMerge";
import { resourceOutputPath } from "./resourceIds";
import { RsglTargetPackFormat } from "./target";

export interface LowerItemUnitsForTargetResult {
  units: ResourceUnit[];
  diagnostics: RsglCompileDiagnostic[];
}

interface LegacyItemLowering {
  baseModel: string;
  overrides: LegacyItemOverride[];
}

interface LegacyItemOverride {
  predicate: Record<string, number>;
  model: string;
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
  const lowered = lowerLegacyItemModel(model, unit, diagnostics);
  if (!lowered) {
    return [];
  }
  if (lowered.baseModel === itemModelId(unit.id) && lowered.overrides.length === 0 && modelOutputPaths.has(normalizedPath(outputPath))) {
    return [];
  }
  return [legacyUnit(unit, outputPath, legacyContent(unit.id, lowered))];
}

function lowerLegacyItemModel(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): LegacyItemLowering | null {
  const type = itemModelType(model.type);
  if (type === "model") {
    const modelValue = modelRef(model);
    return modelValue ? { baseModel: modelValue, overrides: [] } : null;
  }
  if (type === "range_dispatch") {
    return lowerLegacyRangeDispatch(model, unit, diagnostics);
  }
  if (type === "select") {
    return lowerLegacySelect(model, unit, diagnostics);
  }
  if (type === "condition") {
    return lowerLegacyCondition(model, unit, diagnostics);
  }

  pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", `Legacy item backend does not support '${String(model.type)}' item models.`);
  return null;
}

function lowerLegacyRangeDispatch(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): LegacyItemLowering | null {
  const predicate = rangePredicateName(model);
  const entries = Array.isArray(model.entries) ? model.entries : null;
  const fallback = isJsonObject(model.fallback) ? lowerLegacyItemModel(model.fallback, unit, diagnostics) : null;
  if (!predicate || !entries || !fallback) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy range_dispatch lowering requires a supported property, entries, and a model fallback.");
    return null;
  }
  if (fallback.overrides.length > 0) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy range_dispatch lowering requires a plain fallback model.");
    return null;
  }

  const overrides: LegacyItemOverride[] = [];
  for (const entry of entries) {
    const entryObject = isJsonObject(entry) ? entry : null;
    const threshold = typeof entryObject?.threshold === "number" && Number.isFinite(entryObject.threshold)
      ? entryObject.threshold
      : null;
    const branch = isJsonObject(entryObject?.model) ? lowerLegacyItemModel(entryObject.model, unit, diagnostics) : null;
    if (threshold === null || !branch) {
      pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy range_dispatch entries must use finite thresholds and lowerable model branches.");
      return null;
    }
    const branchOverrides = prefixLowering({ [predicate]: threshold }, branch, unit, diagnostics);
    if (!branchOverrides) {
      return null;
    }
    overrides.push(...branchOverrides);
  }

  return { baseModel: fallback.baseModel, overrides };
}

function lowerLegacySelect(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): LegacyItemLowering | null {
  if (normalizedProperty(model.property) !== "custom_model_data") {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy select lowering currently supports only custom_model_data cases.");
    return null;
  }

  const cases = Array.isArray(model.cases) ? model.cases : null;
  const fallback = isJsonObject(model.fallback) ? lowerLegacyItemModel(model.fallback, unit, diagnostics) : null;
  if (!cases || !fallback) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy select lowering requires cases and a model fallback.");
    return null;
  }
  if (fallback.overrides.length > 0) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy select lowering requires a plain fallback model.");
    return null;
  }

  const overrides: LegacyItemOverride[] = [];
  for (const itemCase of cases) {
    const caseObject = isJsonObject(itemCase) ? itemCase : null;
    const whenValues = legacyNumericPredicateValues(caseObject?.when);
    const branch = isJsonObject(caseObject?.model) ? lowerLegacyItemModel(caseObject.model, unit, diagnostics) : null;
    if (!whenValues || !branch) {
      pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy select cases must use numeric custom_model_data values and lowerable model branches.");
      return null;
    }
    for (const when of whenValues) {
      const branchOverrides = prefixLowering({ ["custom_model_data"]: when }, branch, unit, diagnostics);
      if (!branchOverrides) {
        return null;
      }
      overrides.push(...branchOverrides);
    }
  }

  return { baseModel: fallback.baseModel, overrides };
}

function lowerLegacyCondition(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): LegacyItemLowering | null {
  const predicate = conditionPredicateName(model);
  const onTrue = isJsonObject(model["on_true"]) ? lowerLegacyItemModel(model["on_true"], unit, diagnostics) : null;
  const onFalse = isJsonObject(model["on_false"]) ? lowerLegacyItemModel(model["on_false"], unit, diagnostics) : null;
  if (!predicate || !onTrue || !onFalse) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy condition lowering requires a supported property and lowerable model branches.");
    return null;
  }
  if (onFalse.overrides.length > 0) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy condition lowering requires a plain on_false model.");
    return null;
  }

  const overrides = prefixLowering({ [predicate]: 1 }, onTrue, unit, diagnostics);
  return overrides ? { baseModel: onFalse.baseModel, overrides } : null;
}

function prefixLowering(
  predicate: Record<string, number>,
  lowering: LegacyItemLowering,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): LegacyItemOverride[] | null {
  const overrides: LegacyItemOverride[] = [
    { predicate: { ...predicate }, model: lowering.baseModel }
  ];
  for (const override of lowering.overrides) {
    const merged = mergePredicates(predicate, override.predicate);
    if (!merged) {
      pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy item backend cannot combine conflicting nested predicates.");
      return null;
    }
    overrides.push({
      predicate: merged,
      model: override.model
    });
  }
  return overrides;
}

function mergePredicates(
  base: Record<string, number>,
  nested: Record<string, number>
): Record<string, number> | null {
  const result = { ...base };
  for (const [key, value] of Object.entries(nested)) {
    if (Object.hasOwn(result, key) && result[key] !== value) {
      return null;
    }
    result[key] = value;
  }
  return result;
}

function legacyContent(itemId: ResourceId, lowering: LegacyItemLowering): Record<string, JsonValue> {
  return withOverrides(
    legacyBaseModel(itemId, lowering.baseModel),
    lowering.overrides.map(override => ({
      predicate: override.predicate,
      model: override.model
    }))
  );
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
  if (property === "crossbow/pull") {
    return "pull";
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
  if (property === "fishing_rod/cast") {
    return "cast";
  }
  if (property === "blocking" || property === "damaged" || property === "broken") {
    return property;
  }
  return null;
}

function normalizedProperty(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value.replace(/^minecraft:/, "") : null;
}

function legacyNumericPredicateValues(value: JsonValue | undefined): number[] | null {
  if (Array.isArray(value)) {
    const values = value.map(item => legacyNumericPredicateValue(item));
    return values.every((item): item is number => item !== null) ? values : null;
  }
  const single = legacyNumericPredicateValue(value);
  return single === null ? null : [single];
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
