import {
  findItemModelNodeSchema,
  findItemModelPropertySchema,
  findItemModelSpecialSchema,
  findItemModelTintSchema,
  isItemModelSchemaEntryAvailable,
  itemModelHistoricalFormats,
  itemModelPropertySchemas,
  itemModelRootFields,
  itemModelSpecialVariantsForTarget,
  itemModelTransformationSchema,
  projectItemModelSchemaVariants,
  type ItemModelFieldSchema,
  type ItemModelFormat,
  type ItemModelPropertySchema,
  type ItemModelSchemaLifecycle,
  type ItemModelSpecialSchema
} from "../itemModelSchema";
import type { JsonValue } from "./ir";
import { isJsonObject } from "./jsonValues";
import { appendGeneratedPath } from "./sourcePaths";
import { stripMinecraftPrefix } from "./validationPrimitives";

export interface ItemModelHistoricalShapeIssue {
  readonly generatedPath: string;
  readonly message: string;
}

type ItemPropertyFamily = keyof typeof itemModelPropertySchemas;

interface HistoricalShapeState {
  readonly history: readonly ItemModelFormat[];
  candidates: ItemModelFormat[];
  issue?: ItemModelHistoricalShapeIssue;
}

/**
 * Checks whether one complete historical schema accepts an item-model tree.
 *
 * Target-neutral validation still reports ordinary structural/type errors via
 * the regular validators. This pass considers only constraints whose accepted
 * set changes over schema history, intersects them across the complete tree,
 * and reports the first exact field that makes that intersection empty.
 */
export function findItemModelHistoricalShapeIssue(
  value: JsonValue,
  generatedPath: string
): ItemModelHistoricalShapeIssue | undefined {
  const state = createHistoricalShapeState();
  visitItemModel(value, generatedPath, state);
  return state.issue;
}

/** Applies the same historical candidate to root flags and the model tree. */
export function findItemDefinitionHistoricalShapeIssue(
  value: Record<string, JsonValue>,
  generatedPath: string
): ItemModelHistoricalShapeIssue | undefined {
  const state = createHistoricalShapeState();
  const rootRules = new Map(itemModelRootFields.map(rule => [rule.name, rule]));
  for (const key of Object.keys(value)) {
    const fieldPath = appendGeneratedPath(generatedPath, key);
    const rule = rootRules.get(key);
    if (rule) {
      constrainLifecycle(state, rule, fieldPath, "item definition field '" + key + "'");
    }
    if (key === "model") {
      visitItemModel(value.model, fieldPath, state);
    }
    if (state.issue) {
      break;
    }
  }
  return state.issue;
}

function createHistoricalShapeState(): HistoricalShapeState {
  const history = itemModelHistoricalFormats();
  return {
    history,
    candidates: [...history]
  };
}

function visitItemModel(
  value: JsonValue | undefined,
  generatedPath: string,
  state: HistoricalShapeState
): void {
  if (state.issue || !isJsonObject(value)) {
    return;
  }
  const type = stripMinecraftPrefix(value.type);
  const schema = type ? findItemModelNodeSchema(type) : undefined;
  if (!type || !schema) {
    return;
  }

  constrainLifecycle(
    state,
    schema,
    appendGeneratedPath(generatedPath, "type"),
    "item model type '" + type + "'"
  );

  const family = itemPropertyFamily(type);
  const property = family ? stripMinecraftPrefix(value.property) : null;
  const propertySchema = family && property
    ? findItemModelPropertySchema(family, property)
    : undefined;
  const propertyRules = family && propertySchema
    ? [...itemModelPropertySchemas[family].commonFields, ...propertySchema.fields]
    : [];

  for (const key of Object.keys(value)) {
    if (state.issue) {
      return;
    }
    const fieldPath = appendGeneratedPath(generatedPath, key);
    if (key === "property" && propertySchema) {
      constrainLifecycle(
        state,
        propertySchema,
        fieldPath,
        "item " + family + " property '" + property + "'"
      );
      continue;
    }
    if (key === "transformation" && schema.allowsTransformation) {
      constrainLifecycle(state, itemModelTransformationSchema, fieldPath, "item model transformation");
      continue;
    }
    if (key === "tints" && schema.allowsTints) {
      visitTints(value[key], fieldPath, state);
      continue;
    }
    if (family && propertySchema) {
      const rules = propertyRules.filter(rule => rule.name === key);
      if (rules.length > 0) {
        constrainPropertyField(state, rules, value[key], fieldPath, family, propertySchema);
      }
    }
  }

  if (family && propertySchema) {
    constrainMissingPropertyFields(
      state,
      propertyRules,
      value,
      generatedPath,
      family,
      propertySchema
    );
  }

  if (type === "model" || type === "empty" || type === "bundle/selected_item") {
    return;
  }
  if (type === "composite") {
    visitModelArray(value.models, appendGeneratedPath(generatedPath, "models"), state);
    return;
  }
  if (type === "condition") {
    visitItemModel(value.on_true, appendGeneratedPath(generatedPath, "on_true"), state);
    visitItemModel(value.on_false, appendGeneratedPath(generatedPath, "on_false"), state);
    return;
  }
  if (type === "select") {
    visitSelectCases(value.cases, generatedPath, propertySchema, state);
    visitItemModel(value.fallback, appendGeneratedPath(generatedPath, "fallback"), state);
    return;
  }
  if (type === "range_dispatch") {
    visitRangeEntries(value.entries, generatedPath, state);
    visitItemModel(value.fallback, appendGeneratedPath(generatedPath, "fallback"), state);
    return;
  }
  if (type === "special") {
    visitSpecialModel(value.model, appendGeneratedPath(generatedPath, "model"), state);
  }
}

function constrainPropertyField(
  state: HistoricalShapeState,
  rules: readonly ItemModelFieldSchema[],
  value: JsonValue,
  generatedPath: string,
  family: ItemPropertyFamily,
  property: ItemModelPropertySchema
): void {
  constrain(
    state,
    generatedPath,
    "field '" + rules[0].name + "' of item " + family + " property '" + property.name + "'",
    target => isItemModelSchemaEntryAvailable(property, target)
      && rules.some(rule => isItemModelSchemaEntryAvailable(rule, target)
        && historicalFieldValueMatches(rule, value))
  );
}

function constrainMissingPropertyFields(
  state: HistoricalShapeState,
  rules: readonly ItemModelFieldSchema[],
  object: Record<string, JsonValue>,
  generatedPath: string,
  family: ItemPropertyFamily,
  property: ItemModelPropertySchema
): void {
  for (const name of new Set(rules.map(rule => rule.name))) {
    if (Object.hasOwn(object, name)) {
      continue;
    }
    const fieldRules = rules.filter(rule => rule.name === name);
    constrain(
      state,
      appendGeneratedPath(generatedPath, name),
      "required field '" + name + "' of item " + family + " property '" + property.name + "'",
      target => isItemModelSchemaEntryAvailable(property, target)
        && !fieldRules.some(rule => isItemModelSchemaEntryAvailable(rule, target) && rule.required)
    );
  }
}

function visitSelectCases(
  value: JsonValue | undefined,
  generatedPath: string,
  property: ItemModelPropertySchema | undefined,
  state: HistoricalShapeState
): void {
  if (!Array.isArray(value)) {
    return;
  }
  const casesPath = appendGeneratedPath(generatedPath, "cases");
  for (const [index, itemCase] of value.entries()) {
    if (!isJsonObject(itemCase)) {
      continue;
    }
    const casePath = appendGeneratedPath(casesPath, String(index));
    if (property?.whenValueKind === "enum" && Object.hasOwn(itemCase, "when")) {
      const when = itemCase.when;
      constrain(
        state,
        appendGeneratedPath(casePath, "when"),
        "case value of item select property '" + property.name + "'",
        target => selectWhenValueMatches(property, when, target)
      );
    }
    visitItemModel(itemCase.model, appendGeneratedPath(casePath, "model"), state);
  }
}

function selectWhenValueMatches(
  property: ItemModelPropertySchema,
  value: JsonValue,
  target: ItemModelFormat
): boolean {
  if (!isItemModelSchemaEntryAvailable(property, target)) {
    return false;
  }
  const allowed = property.whenVariants
    ? projectItemModelSchemaVariants(property.whenVariants, target).flatMap(variant => variant.values)
    : property.whenValues ?? [];
  const values = Array.isArray(value) ? value : [value];
  return values.every(item => {
    const normalized = stripMinecraftPrefix(item);
    return normalized !== null && allowed.includes(normalized);
  });
}

function visitRangeEntries(
  value: JsonValue | undefined,
  generatedPath: string,
  state: HistoricalShapeState
): void {
  if (!Array.isArray(value)) {
    return;
  }
  const entriesPath = appendGeneratedPath(generatedPath, "entries");
  for (const [index, entry] of value.entries()) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const entryPath = appendGeneratedPath(entriesPath, String(index));
    visitItemModel(entry.model, appendGeneratedPath(entryPath, "model"), state);
  }
}

function visitModelArray(
  value: JsonValue | undefined,
  generatedPath: string,
  state: HistoricalShapeState
): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const [index, child] of value.entries()) {
    visitItemModel(child, appendGeneratedPath(generatedPath, String(index)), state);
  }
}

function visitTints(
  value: JsonValue,
  generatedPath: string,
  state: HistoricalShapeState
): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const [index, tint] of value.entries()) {
    if (!isJsonObject(tint)) {
      continue;
    }
    const type = stripMinecraftPrefix(tint.type);
    const schema = type ? findItemModelTintSchema(type) : undefined;
    if (!type || !schema) {
      continue;
    }
    const tintPath = appendGeneratedPath(generatedPath, String(index));
    constrainLifecycle(
      state,
      schema,
      appendGeneratedPath(tintPath, "type"),
      "item tint '" + type + "'"
    );
    for (const rule of schema.fields) {
      if (Object.hasOwn(tint, rule.name)) {
        constrain(
          state,
          appendGeneratedPath(tintPath, rule.name),
          "field '" + rule.name + "' of item tint '" + type + "'",
          target => isItemModelSchemaEntryAvailable(schema, target)
            && isItemModelSchemaEntryAvailable(rule, target)
            && historicalFieldValueMatches(rule, tint[rule.name])
        );
      } else {
        constrain(
          state,
          appendGeneratedPath(tintPath, rule.name),
          "required field '" + rule.name + "' of item tint '" + type + "'",
          target => isItemModelSchemaEntryAvailable(schema, target)
            && (!isItemModelSchemaEntryAvailable(rule, target) || !rule.required)
        );
      }
    }
  }
}

function visitSpecialModel(
  value: JsonValue | undefined,
  generatedPath: string,
  state: HistoricalShapeState
): void {
  if (!isJsonObject(value)) {
    return;
  }
  const type = stripMinecraftPrefix(value.type);
  const schema = type ? findItemModelSpecialSchema(type) : undefined;
  if (!type || !schema) {
    return;
  }
  constrainLifecycle(
    state,
    schema,
    appendGeneratedPath(generatedPath, "type"),
    "item special model type '" + type + "'"
  );

  const knownFields = new Set(
    schema.variants.flatMap(variant => variant.value.fields.map(rule => rule.name))
  );
  for (const key of Object.keys(value)) {
    if (key === "type" || !knownFields.has(key)) {
      continue;
    }
    constrainSpecialField(
      state,
      schema,
      key,
      value[key],
      appendGeneratedPath(generatedPath, key)
    );
  }

  for (const name of knownFields) {
    if (Object.hasOwn(value, name)) {
      continue;
    }
    constrain(
      state,
      appendGeneratedPath(generatedPath, name),
      "required field '" + name + "' of item special model '" + type + "'",
      target => {
        const variant = specialVariantAt(schema, target);
        return variant !== undefined
          && !variant.some(rule => rule.name === name && rule.required);
      }
    );
  }
}

function constrainSpecialField(
  state: HistoricalShapeState,
  schema: ItemModelSpecialSchema,
  name: string,
  value: JsonValue,
  generatedPath: string
): void {
  constrain(
    state,
    generatedPath,
    "field '" + name + "' of item special model '" + schema.name + "'",
    target => {
      const variant = specialVariantAt(schema, target);
      return variant?.some(rule => rule.name === name && historicalFieldValueMatches(rule, value)) ?? false;
    }
  );
}

function specialVariantAt(
  schema: ItemModelSpecialSchema,
  target: ItemModelFormat
): readonly ItemModelFieldSchema[] | undefined {
  return itemModelSpecialVariantsForTarget(schema, target)[0]?.fields
    .filter(rule => isItemModelSchemaEntryAvailable(rule, target));
}

function constrainLifecycle(
  state: HistoricalShapeState,
  lifecycle: ItemModelSchemaLifecycle,
  generatedPath: string,
  subject: string
): void {
  constrain(
    state,
    generatedPath,
    subject,
    target => isItemModelSchemaEntryAvailable(lifecycle, target)
  );
}

function constrain(
  state: HistoricalShapeState,
  generatedPath: string,
  subject: string,
  accepts: (target: ItemModelFormat) => boolean
): void {
  if (state.issue) {
    return;
  }
  const historicallyAccepted = state.history.filter(accepts);
  // An invariantly invalid shape is diagnosed by the ordinary structural/type
  // validators. It is not a cross-version composition failure.
  if (historicallyAccepted.length === 0 || historicallyAccepted.length === state.history.length) {
    return;
  }
  const remaining = state.candidates.filter(accepts);
  if (remaining.length === 0) {
    state.issue = {
      generatedPath,
      message: "No single supported pack-format schema accepts this complete item-model shape; "
        + subject + " conflicts with version-sensitive fields elsewhere. Declare an explicit target for exact version diagnostics."
    };
    return;
  }
  state.candidates = remaining;
}

function historicalFieldValueMatches(rule: ItemModelFieldSchema, value: JsonValue): boolean {
  if (rule.kind !== "enum") {
    return true;
  }
  const normalized = stripMinecraftPrefix(value);
  return normalized !== null && (rule.values ?? []).includes(normalized);
}

function itemPropertyFamily(type: string): ItemPropertyFamily | undefined {
  if (type === "condition" || type === "select" || type === "range_dispatch") {
    return type;
  }
  return undefined;
}
