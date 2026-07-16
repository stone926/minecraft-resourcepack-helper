import {
  isExternalResourceUnit,
  JsonValue,
  ResourceId,
  ResourceUnit,
  RsglCompileDiagnostic,
  RsglValidationReferenceOrigin
} from "./ir";
import type { RsglResourceValueObservation } from "./evaluatedResourceValues";
import { isJsonObject } from "./jsonValues";
import { resourceOutputPath } from "./resourceIds";
import { appendGeneratedPath } from "./sourcePaths";
import type { RsglTargetPackFormat } from "./targetConfig";
import { sourceFileForValidationRange, sourceRangeForGeneratedPath } from "./validationDiagnostics";
import { stripMinecraftPrefix } from "./validationPrimitives";
import {
  legacySelectPropertyOptionIssues,
  resolveLegacyRangeProperty,
  type LegacyItemPropertyOptionIssue
} from "./itemLegacyPropertyOptions";
import {
  ITEM_MODEL_DEFINITION_INTRODUCED_FORMAT,
  compareItemModelFormats,
  itemModelFormatFromTarget
} from "../itemModelSchema";

export interface LowerItemUnitsForTargetResult {
  units: ResourceUnit[];
  diagnostics: RsglCompileDiagnostic[];
}

interface LegacyItemLowering {
  baseModel: LegacyModelReference;
  overrides: LegacyItemOverride[];
}

interface LegacyItemOverride {
  predicate: Record<string, number>;
  model: LegacyModelReference;
}

interface LegacyModelReference {
  id: string;
  sourcePath: string;
}

export function lowerItemUnitsForTarget(
  units: ResourceUnit[],
  targetPackFormat: RsglTargetPackFormat | undefined
): LowerItemUnitsForTargetResult {
  if (!usesLegacyItemBackend(targetPackFormat)) {
    return { units, diagnostics: [] };
  }

  const diagnostics: RsglCompileDiagnostic[] = [];
  const modelOutputPaths = new Set(units
    .filter(unit => unit.kind === "model" && !isExternalResourceUnit(unit))
    .map(unit => normalizedPath(unit.outputPath)));
  const lowered = units.flatMap(unit => unit.kind === "item" && !isExternalResourceUnit(unit)
    ? lowerItemUnitToLegacy(unit, modelOutputPaths, diagnostics)
    : [unit]);
  return { units: lowered, diagnostics };
}

/**
 * Item definitions are a source-level RSGL representation even for targets
 * that predate the item-definition resource directory. Those targets must
 * validate the representation before this backend replaces it with a legacy
 * model unit.
 */
export function usesLegacyItemBackend(
  targetPackFormat: RsglTargetPackFormat | undefined
): boolean {
  const target = itemModelFormatFromTarget(targetPackFormat);
  return target !== undefined
    && compareItemModelFormats(target, ITEM_MODEL_DEFINITION_INTRODUCED_FORMAT) < 0;
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
  if (content) {
    const unsupportedRootField = [
      "hand_animation_on_swap",
      "oversized_in_gui",
      "swap_animation_scale"
    ].find(field => Object.hasOwn(content, field));
    if (unsupportedRootField) {
      pushLegacyDiagnostic(
        unit,
        diagnostics,
        "rsgl.unsupportedLegacyItemModel",
        "Legacy item backend cannot represent item root field '" + unsupportedRootField + "'.",
        appendGeneratedPath("", unsupportedRootField)
      );
      return [];
    }
  }
  const model = isJsonObject(content?.model) ? content.model : null;
  if (!model) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy item backend requires an item model object.");
    return [];
  }

  const outputPath = legacyItemModelOutputPath(unit.id);
  const lowered = lowerLegacyItemModel(model, unit, diagnostics, "/model");
  if (!lowered) {
    return [];
  }
  if (lowered.baseModel.id === itemModelId(unit.id) && lowered.overrides.length === 0 && modelOutputPaths.has(normalizedPath(outputPath))) {
    return [];
  }
  return [legacyUnit(unit, outputPath, lowered)];
}

function lowerLegacyItemModel(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): LegacyItemLowering | null {
  for (const field of ["tints", "transformation"]) {
    if (!Object.hasOwn(model, field)) {
      continue;
    }
    pushLegacyDiagnostic(
      unit,
      diagnostics,
      "rsgl.unsupportedLegacyItemModel",
      "Legacy item backend cannot represent item model field '" + field + "'.",
      appendGeneratedPath(generatedPath, field)
    );
    return null;
  }
  const type = stripMinecraftPrefix(model.type);
  if (type === "model") {
    const modelValue = modelRef(model, appendGeneratedPath(generatedPath, "model"));
    return modelValue ? { baseModel: modelValue, overrides: [] } : null;
  }
  if (type === "range_dispatch") {
    return lowerLegacyRangeDispatch(model, unit, diagnostics, generatedPath);
  }
  if (type === "select") {
    return lowerLegacySelect(model, unit, diagnostics, generatedPath);
  }
  if (type === "condition") {
    return lowerLegacyCondition(model, unit, diagnostics, generatedPath);
  }

  pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", `Legacy item backend does not support '${String(model.type)}' item models.`);
  return null;
}

function lowerLegacyRangeDispatch(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): LegacyItemLowering | null {
  const propertyResolution = resolveLegacyRangeProperty(model);
  if (pushLegacyPropertyOptionIssues(unit, diagnostics, generatedPath, propertyResolution.issues)) {
    return null;
  }
  const configuration = propertyResolution.configuration;
  if (!configuration) {
    return null;
  }
  const entries = Array.isArray(model.entries) ? model.entries : null;
  const fallbackPath = appendGeneratedPath(generatedPath, "fallback");
  const fallback = isJsonObject(model.fallback)
    ? lowerLegacyItemModel(model.fallback, unit, diagnostics, fallbackPath)
    : null;
  if (!entries || !fallback) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy range_dispatch lowering requires a supported property, entries, and a model fallback.");
    return null;
  }
  if (fallback.overrides.length > 0) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy range_dispatch lowering requires a plain fallback model.");
    return null;
  }

  const entryLowerings: Array<{
    order: number;
    threshold: number;
    overrides: LegacyItemOverride[];
  }> = [];
  for (const [index, entry] of entries.entries()) {
    const entryObject = isJsonObject(entry) ? entry : null;
    const threshold = typeof entryObject?.threshold === "number" && Number.isFinite(entryObject.threshold)
      ? entryObject.threshold
      : null;
    const branchPath = appendGeneratedPath(
      appendGeneratedPath(appendGeneratedPath(generatedPath, "entries"), String(index)),
      "model"
    );
    const branch = isJsonObject(entryObject?.model)
      ? lowerLegacyItemModel(entryObject.model, unit, diagnostics, branchPath)
      : null;
    if (threshold === null || !branch) {
      pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy range_dispatch entries must use finite thresholds and lowerable model branches.");
      return null;
    }
    const legacyThreshold = threshold / configuration.thresholdScale;
    if (!Number.isFinite(legacyThreshold)) {
      pushLegacyDiagnostic(
        unit,
        diagnostics,
        "rsgl.unsupportedLegacyItemModel",
        "Legacy range_dispatch lowering cannot represent thresholds after applying 'scale'.",
        appendGeneratedPath(generatedPath, "scale")
      );
      return null;
    }
    const branchOverrides = prefixLowering(
      { [configuration.predicate]: legacyThreshold },
      branch,
      unit,
      diagnostics
    );
    if (!branchOverrides) {
      return null;
    }
    entryLowerings.push({ order: index, threshold: legacyThreshold, overrides: branchOverrides });
  }

  entryLowerings.sort((left, right) =>
    left.threshold - right.threshold || left.order - right.order
  );
  return {
    baseModel: fallback.baseModel,
    overrides: entryLowerings.flatMap(entry => entry.overrides)
  };
}

function lowerLegacySelect(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): LegacyItemLowering | null {
  const property = normalizedProperty(model.property);
  if (property === "main_hand") {
    return lowerLegacyMainHandSelect(model, unit, diagnostics, generatedPath);
  }
  if (property === "charge_type") {
    return lowerLegacyChargeTypeSelect(model, unit, diagnostics, generatedPath);
  }
  if (property !== "custom_model_data") {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy select lowering currently supports custom_model_data, main_hand, and charge_type cases.");
    return null;
  }
  if (pushLegacyPropertyOptionIssues(
    unit,
    diagnostics,
    generatedPath,
    legacySelectPropertyOptionIssues(model)
  )) {
    return null;
  }

  const cases = Array.isArray(model.cases) ? model.cases : null;
  const fallbackPath = appendGeneratedPath(generatedPath, "fallback");
  const fallback = isJsonObject(model.fallback)
    ? lowerLegacyItemModel(model.fallback, unit, diagnostics, fallbackPath)
    : null;
  if (!cases || !fallback) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy select lowering requires cases and a model fallback.");
    return null;
  }
  if (fallback.overrides.length > 0) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy select lowering requires a plain fallback model.");
    return null;
  }

  const overrides: LegacyItemOverride[] = [];
  for (const [index, itemCase] of cases.entries()) {
    const caseObject = isJsonObject(itemCase) ? itemCase : null;
    const whenValues = legacyNumericPredicateValues(caseObject?.when);
    const branchPath = appendGeneratedPath(
      appendGeneratedPath(appendGeneratedPath(generatedPath, "cases"), String(index)),
      "model"
    );
    const branch = isJsonObject(caseObject?.model)
      ? lowerLegacyItemModel(caseObject.model, unit, diagnostics, branchPath)
      : null;
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

function lowerLegacyMainHandSelect(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): LegacyItemLowering | null {
  const cases = Array.isArray(model.cases) ? model.cases : null;
  const fallbackPath = appendGeneratedPath(generatedPath, "fallback");
  const fallback = isJsonObject(model.fallback)
    ? lowerLegacyItemModel(model.fallback, unit, diagnostics, fallbackPath)
    : null;
  if (!cases || !fallback) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy main_hand select lowering requires cases and a model fallback.");
    return null;
  }
  if (fallback.overrides.length > 0) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy main_hand select lowering requires a plain fallback model.");
    return null;
  }

  const rightHandOverrides: LegacyItemOverride[] = [];
  const leftHandOverrides: LegacyItemOverride[] = [];
  for (const [index, itemCase] of cases.entries()) {
    const caseObject = isJsonObject(itemCase) ? itemCase : null;
    const whenValues = legacyMainHandValues(caseObject?.when);
    const branchPath = appendGeneratedPath(
      appendGeneratedPath(appendGeneratedPath(generatedPath, "cases"), String(index)),
      "model"
    );
    const branch = isJsonObject(caseObject?.model)
      ? lowerLegacyItemModel(caseObject.model, unit, diagnostics, branchPath)
      : null;
    if (!whenValues || !branch) {
      pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy main_hand select cases must use 'left'/'right' values and lowerable model branches.");
      return null;
    }
    for (const when of whenValues) {
      const predicate = when === "left"
        ? { lefthanded: 1 }
        : { lefthanded: 0 };
      const branchOverrides = prefixLowering(predicate, branch, unit, diagnostics);
      if (!branchOverrides) {
        return null;
      }
      if (when === "left") {
        leftHandOverrides.push(...branchOverrides);
      } else {
        rightHandOverrides.push(...branchOverrides);
      }
    }
  }

  return {
    baseModel: fallback.baseModel,
    overrides: [
      ...rightHandOverrides,
      ...(rightHandOverrides.length > 0 && leftHandOverrides.length === 0
        ? [{ predicate: { lefthanded: 1 }, model: fallback.baseModel }]
        : []),
      ...leftHandOverrides
    ]
  };
}

function lowerLegacyChargeTypeSelect(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): LegacyItemLowering | null {
  const cases = Array.isArray(model.cases) ? model.cases : null;
  const fallbackPath = appendGeneratedPath(generatedPath, "fallback");
  const fallback = isJsonObject(model.fallback)
    ? lowerLegacyItemModel(model.fallback, unit, diagnostics, fallbackPath)
    : null;
  if (!cases || !fallback) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy charge_type select lowering requires cases and a fallback model.");
    return null;
  }

  const arrowOverrides: LegacyItemOverride[] = [];
  const rocketOverrides: LegacyItemOverride[] = [];
  let hasArrowCase = false;
  let hasRocketCase = false;
  for (const [index, itemCase] of cases.entries()) {
    const caseObject = isJsonObject(itemCase) ? itemCase : null;
    const whenValues = legacyChargeTypeValues(caseObject?.when);
    const branchPath = appendGeneratedPath(
      appendGeneratedPath(appendGeneratedPath(generatedPath, "cases"), String(index)),
      "model"
    );
    const branch = isJsonObject(caseObject?.model)
      ? lowerLegacyItemModel(caseObject.model, unit, diagnostics, branchPath)
      : null;
    if (!whenValues || !branch) {
      pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy charge_type select cases must use 'arrow', 'rocket', or 'none' values and lowerable model branches.");
      return null;
    }

    for (const when of whenValues) {
      if (when === "none") {
        if (!sameLowering(branch, fallback)) {
          pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy charge_type select cannot represent a 'none' case different from the fallback model.");
          return null;
        }
        continue;
      }

      const branchOverrides = prefixLowering(chargeTypePredicate(when), branch, unit, diagnostics);
      if (!branchOverrides) {
        return null;
      }
      if (when === "rocket") {
        hasRocketCase = true;
        rocketOverrides.push(...branchOverrides);
      } else {
        hasArrowCase = true;
        arrowOverrides.push(...branchOverrides);
      }
    }
  }

  // The legacy `charged` predicate also matches firework-loaded crossbows.
  // Place the complete fallback tree after arrow overrides so the missing
  // rocket case retains every nested fallback decision, not just its base.
  const rocketFallbackOverrides = hasArrowCase && !hasRocketCase
    ? prefixLowering(chargeTypePredicate("rocket"), fallback, unit, diagnostics)
    : [];
  if (!rocketFallbackOverrides) {
    return null;
  }

  return {
    baseModel: fallback.baseModel,
    overrides: [
      ...fallback.overrides,
      ...arrowOverrides,
      ...rocketFallbackOverrides,
      ...rocketOverrides
    ]
  };
}

function lowerLegacyCondition(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): LegacyItemLowering | null {
  const property = normalizedProperty(model.property);
  if (property === "using_item") {
    pushLegacyDiagnostic(
      unit,
      diagnostics,
      "rsgl.unsupportedLegacyItemModel",
      "Legacy item overrides cannot losslessly represent the general 'using_item' condition as the item-specific 'pulling' predicate.",
      appendGeneratedPath(generatedPath, "property")
    );
    return null;
  }
  const predicate = conditionPredicateName(model);
  if (!predicate) {
    pushLegacyDiagnostic(
      unit,
      diagnostics,
      "rsgl.unsupportedLegacyItemModel",
      "Legacy condition lowering requires a supported property.",
      appendGeneratedPath(generatedPath, "property")
    );
    return null;
  }
  const onTrue = isJsonObject(model["on_true"])
    ? lowerLegacyItemModel(model["on_true"], unit, diagnostics, appendGeneratedPath(generatedPath, "on_true"))
    : null;
  const onFalse = isJsonObject(model["on_false"])
    ? lowerLegacyItemModel(model["on_false"], unit, diagnostics, appendGeneratedPath(generatedPath, "on_false"))
    : null;
  if (!onTrue || !onFalse) {
    pushLegacyDiagnostic(unit, diagnostics, "rsgl.unsupportedLegacyItemModel", "Legacy condition lowering requires lowerable model branches.");
    return null;
  }

  const overrides = prefixLowering({ [predicate]: 1 }, onTrue, unit, diagnostics);
  return overrides
    ? { baseModel: onFalse.baseModel, overrides: [...onFalse.overrides, ...overrides] }
    : null;
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
      model: override.model.id
    }))
  );
}

function legacyBaseModel(itemId: ResourceId, model: LegacyModelReference): Record<string, JsonValue> {
  if (model.id === itemModelId(itemId)) {
    return {
      parent: "minecraft:item/generated",
      textures: {
        layer0: model.id
      }
    };
  }
  return { parent: model.id };
}

function withOverrides(base: Record<string, JsonValue>, overrides: JsonValue[]): Record<string, JsonValue> {
  return overrides.length > 0
    ? { ...base, overrides }
    : base;
}

function legacyUnit(
  source: ResourceUnit,
  outputPath: string,
  lowering: LegacyItemLowering
): ResourceUnit {
  const id = source.id
    ? { namespace: source.id.namespace, path: `item/${source.id.path}` }
    : undefined;
  const referenceOrigins = legacyReferenceOrigins(source, lowering);
  const resourceValueObservations = legacyResourceValueObservations(source, lowering);
  return {
    ...source,
    id,
    kind: "model",
    outputPath,
    content: source.id ? legacyContent(source.id, lowering) : {},
    validation: {
      ...source.validation,
      referenceOrigins: [
        ...(source.validation?.referenceOrigins ?? []),
        ...referenceOrigins
      ],
      resourceValueObservations
    },
    sourceMap: {
      ...source.sourceMap,
      generatedFile: outputPath
    }
  };
}

function legacyReferenceOrigins(
  source: ResourceUnit,
  lowering: LegacyItemLowering
): RsglValidationReferenceOrigin[] {
  return legacyReferences(source, lowering).map(([generatedPath, reference]) => {
    const sourceRange = sourceRangeForGeneratedPath(source, reference.sourcePath);
    return {
      generatedPath,
      sourceFile: sourceFileForValidationRange(source, sourceRange),
      sourceRange
    };
  });
}

function legacyResourceValueObservations(
  source: ResourceUnit,
  lowering: LegacyItemLowering
): RsglResourceValueObservation[] {
  const observations = source.validation?.resourceValueObservations ?? [];
  return legacyReferences(source, lowering).flatMap(([generatedPath, reference]) => {
    for (let index = observations.length - 1; index >= 0; index--) {
      if (observations[index].generatedPath === reference.sourcePath) {
        return [{
          ...observations[index],
          generatedPath,
          // The legacy self-model convention materializes the modern ModelId
          // as the generated model's layer0 texture. Record the kind at the
          // output seam so validation does not reinterpret a valid modern
          // item-model reference as a source-level kind mismatch.
          ...(generatedPath === "/textures/layer0" ? { valueKind: "texture" as const } : {})
        }];
      }
    }
    return [];
  });
}

function legacyReferences(
  source: ResourceUnit,
  lowering: LegacyItemLowering
): Array<[string, LegacyModelReference]> {
  if (!source.id) {
    return [];
  }
  const references: Array<[string, LegacyModelReference]> = [[
    lowering.baseModel.id === itemModelId(source.id) ? "/textures/layer0" : "/parent",
    lowering.baseModel
  ]];
  lowering.overrides.forEach((override, index) => {
    references.push([
      appendGeneratedPath(appendGeneratedPath("/overrides", String(index)), "model"),
      override.model
    ]);
  });
  return references;
}

function modelRef(model: Record<string, JsonValue>, sourcePath: string): LegacyModelReference | null {
  return stripMinecraftPrefix(model.type) === "model" && typeof model.model === "string"
    ? { id: model.model, sourcePath }
    : null;
}

function conditionPredicateName(model: Record<string, JsonValue>): string | null {
  const property = normalizedProperty(model.property);
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

function legacyMainHandValues(value: JsonValue | undefined): Array<"left" | "right"> | null {
  if (Array.isArray(value)) {
    const values = value.map(item => legacyMainHandValue(item));
    return values.every((item): item is "left" | "right" => item !== null) ? values : null;
  }
  const single = legacyMainHandValue(value);
  return single === null ? null : [single];
}

function legacyMainHandValue(value: JsonValue | undefined): "left" | "right" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/^minecraft:/, "");
  return normalized === "left" || normalized === "right" ? normalized : null;
}

function legacyChargeTypeValues(value: JsonValue | undefined): Array<"none" | "arrow" | "rocket"> | null {
  if (Array.isArray(value)) {
    const values = value.map(item => legacyChargeTypeValue(item));
    return values.every((item): item is "none" | "arrow" | "rocket" => item !== null) ? values : null;
  }
  const single = legacyChargeTypeValue(value);
  return single === null ? null : [single];
}

function legacyChargeTypeValue(value: JsonValue | undefined): "none" | "arrow" | "rocket" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/^minecraft:/, "");
  if (normalized === "none" || normalized === "arrow") {
    return normalized;
  }
  if (normalized === "rocket" || normalized === "firework" || normalized === "firework_rocket") {
    return "rocket";
  }
  return null;
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

function chargeTypePredicate(value: "arrow" | "rocket"): Record<string, number> {
  return value === "rocket"
    ? { charged: 1, firework: 1 }
    : { charged: 1 };
}

function sameLowering(left: LegacyItemLowering, right: LegacyItemLowering): boolean {
  return left.baseModel.id === right.baseModel.id
    && JSON.stringify(left.overrides.map(serializableLegacyOverride))
      === JSON.stringify(right.overrides.map(serializableLegacyOverride));
}

function serializableLegacyOverride(override: LegacyItemOverride): Record<string, JsonValue> {
  return { predicate: override.predicate, model: override.model.id };
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
  message: string,
  generatedPath?: string
): void {
  const range = generatedPath
    ? sourceRangeForGeneratedPath(unit, generatedPath)
    : unit.sourceMap.mappings[0]?.sourceRange ?? { start: 0, end: 1 };
  diagnostics.push({
    code,
    message,
    severity: "error",
    range,
    fileName: generatedPath
      ? sourceFileForValidationRange(unit, range)
      : unit.sourceMap.mappings[0]?.sourceFile
  });
}

function pushLegacyPropertyOptionIssues(
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  issues: readonly LegacyItemPropertyOptionIssue[]
): boolean {
  for (const issue of issues) {
    pushLegacyDiagnostic(
      unit,
      diagnostics,
      "rsgl.unsupportedLegacyItemModel",
      issue.message,
      appendGeneratedPath(generatedPath, issue.field)
    );
  }
  return issues.length > 0;
}
