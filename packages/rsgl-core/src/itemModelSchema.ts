/**
 * Frontend-safe Minecraft item-model schema history.
 *
 * This module intentionally has no compiler or VS Code dependencies. Parsers,
 * validators, and completion providers can all project the same data for a
 * concrete target pack format, while an omitted target projects the union of
 * every schema variant known to RSGL.
 */

export type ItemModelFormat = readonly [major: number, minor: number];

export interface ItemModelSchemaLifecycle {
  readonly introduced?: ItemModelFormat;
  /** Exclusive upper bound. */
  readonly removed?: ItemModelFormat;
}

export type ItemModelFieldKind =
  | "boolean"
  | "color"
  | "enum"
  | "finiteNumber"
  | "integer"
  | "json"
  | "nonNegativeInteger"
  | "numberInUnitRange"
  | "positiveNumber"
  | "resourceId"
  | "string";

export interface ItemModelFieldSchema extends ItemModelSchemaLifecycle {
  readonly name: string;
  readonly kind: ItemModelFieldKind;
  readonly required?: boolean;
  readonly values?: readonly string[];
}

export interface ItemModelObjectSchema extends ItemModelSchemaLifecycle {
  readonly name: string;
  readonly fields: readonly ItemModelFieldSchema[];
}

/** Closed object shapes nested inside recursive item-model nodes. */
export interface ItemModelClauseObjectSchema {
  readonly name: string;
  readonly fields: readonly ItemModelFieldSchema[];
}

export interface ItemModelSchemaVariant<T> {
  readonly introduced: ItemModelFormat;
  readonly value: T;
}

export interface ItemModelNodeSchema extends ItemModelSchemaLifecycle {
  readonly name: string;
  readonly requiredFields: readonly string[];
  readonly allowedFields: readonly string[];
  readonly allowsTints?: boolean;
  readonly allowsTransformation?: boolean;
}

export interface ItemModelPropertySchema extends ItemModelSchemaLifecycle {
  readonly name: string;
  readonly fields: readonly ItemModelFieldSchema[];
  readonly whenValues?: readonly string[];
  readonly whenVariants?: readonly ItemModelSchemaVariant<{
    readonly values: readonly string[];
  }>[];
  readonly whenValueKind?: "enum" | "resourceId" | "json";
}

export interface ItemModelPropertyFamilySchema {
  readonly commonFields: readonly ItemModelFieldSchema[];
  readonly properties: readonly ItemModelPropertySchema[];
}

export interface ItemModelSpecialSchema extends ItemModelSchemaLifecycle {
  readonly name: string;
  readonly variants: readonly ItemModelSchemaVariant<{
    readonly fields: readonly ItemModelFieldSchema[];
  }>[];
}

const F44: ItemModelFormat = [44, 0];
const F45: ItemModelFormat = [45, 0];
const F46: ItemModelFormat = [46, 0];
const F48: ItemModelFormat = [48, 0];
const F49: ItemModelFormat = [49, 0];
const F63: ItemModelFormat = [63, 0];
const F65: ItemModelFormat = [65, 0];
const F65_2: ItemModelFormat = [65, 2];
const F70: ItemModelFormat = [70, 0];
const F83: ItemModelFormat = [83, 0];
const F84: ItemModelFormat = [84, 0];
const F86: ItemModelFormat = [86, 0];
const F87: ItemModelFormat = [87, 0];

export const ITEM_MODEL_DEFINITION_INTRODUCED_FORMAT = F44;
export const ITEM_MODEL_TRANSFORMATION_INTRODUCED_FORMAT = F83;
export const itemModelTransformationSchema: ItemModelSchemaLifecycle = {
  introduced: ITEM_MODEL_TRANSFORMATION_INTRODUCED_FORMAT
};

export function compareItemModelFormats(
  left: ItemModelFormat,
  right: ItemModelFormat
): number {
  return left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];
}

export function itemModelFormatFromTarget(
  target: { readonly major: number; readonly minor?: number } | undefined
): ItemModelFormat | undefined {
  return target ? [target.major, target.minor ?? 0] : undefined;
}

/**
 * An omitted target means all supported variants, so every historically valid
 * entry is available.
 */
export function isItemModelSchemaEntryAvailable(
  entry: ItemModelSchemaLifecycle,
  target: ItemModelFormat | undefined
): boolean {
  if (!target) {
    return true;
  }
  if (entry.introduced && compareItemModelFormats(target, entry.introduced) < 0) {
    return false;
  }
  return !entry.removed || compareItemModelFormats(target, entry.removed) < 0;
}

/**
 * Projects ordered schema events. A concrete target receives the last event
 * not newer than that target; an omitted target receives every variant so
 * callers can validate against the historical union.
 */
export function projectItemModelSchemaVariants<T>(
  variants: readonly ItemModelSchemaVariant<T>[],
  target: ItemModelFormat | undefined
): readonly T[] {
  if (!target) {
    return variants.map(variant => variant.value);
  }
  let selected: T | undefined;
  for (const variant of variants) {
    if (compareItemModelFormats(variant.introduced, target) <= 0) {
      selected = variant.value;
    }
  }
  return selected === undefined ? [] : [selected];
}

const field = (
  name: string,
  kind: ItemModelFieldKind,
  options: Omit<ItemModelFieldSchema, "name" | "kind"> = {}
): ItemModelFieldSchema => ({ name, kind, ...options });

const dyeColors = [
  "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink",
  "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"
] as const;

const woodTypes = [
  "oak", "spruce", "birch", "acacia", "cherry", "jungle", "dark_oak",
  "pale_oak", "mangrove", "bamboo", "crimson", "warped"
] as const;

export const itemModelRootFields: readonly ItemModelFieldSchema[] = [
  field("model", "json", { required: true, introduced: F44 }),
  field("hand_animation_on_swap", "boolean", { introduced: F46 }),
  field("oversized_in_gui", "boolean", { introduced: F63 }),
  field("swap_animation_scale", "finiteNumber", { introduced: F70 })
];

export const itemModelClauseObjectSchemas: Readonly<{
  selectCase: ItemModelClauseObjectSchema;
  rangeEntry: ItemModelClauseObjectSchema;
}> = {
  selectCase: {
    name: "select case",
    fields: [
      field("when", "json", { required: true }),
      field("model", "json", { required: true })
    ]
  },
  rangeEntry: {
    name: "range_dispatch entry",
    fields: [
      field("threshold", "finiteNumber", { required: true }),
      field("model", "json", { required: true })
    ]
  }
};

const conditionPropertyFields = [
  field("component", "resourceId"),
  field("ignore_default", "boolean"),
  field("index", "nonNegativeInteger"),
  field("keybind", "string"),
  field("predicate", "string"),
  field("value", "json")
] as const;

const selectPropertyFields = [
  field("block_state_property", "string"),
  field("component", "resourceId"),
  field("index", "nonNegativeInteger"),
  field("locale", "string"),
  field("pattern", "string"),
  field("time_zone", "string")
] as const;

const rangePropertyFields = [
  field("index", "nonNegativeInteger"),
  field("natural_only", "boolean"),
  field("normalize", "boolean"),
  field("period", "positiveNumber"),
  field("remaining", "boolean"),
  field("source", "enum", { values: ["daytime", "moon_phase", "random"] }),
  field("target", "enum", { values: ["spawn", "lodestone", "recovery", "none"] }),
  field("wobble", "boolean")
] as const;

export const itemModelPropertySchemas: Readonly<{
  condition: ItemModelPropertyFamilySchema;
  select: ItemModelPropertyFamilySchema;
  range_dispatch: ItemModelPropertyFamilySchema;
}> = {
  condition: {
    commonFields: [],
    properties: [
      { name: "broken", introduced: F44, fields: [] },
      { name: "bundle/has_selected_item", introduced: F44, fields: [] },
      { name: "carried", introduced: F44, fields: [] },
      {
        name: "component",
        introduced: F49,
        fields: [
          field("predicate", "string", { required: true }),
          field("value", "json", { required: true })
        ]
      },
      { name: "custom_model_data", introduced: F44, fields: [field("index", "nonNegativeInteger")] },
      { name: "damaged", introduced: F44, fields: [] },
      { name: "extended_view", introduced: F45, fields: [] },
      { name: "fishing_rod/cast", introduced: F44, fields: [] },
      {
        name: "has_component",
        introduced: F44,
        fields: [
          field("component", "resourceId", { required: true }),
          field("ignore_default", "boolean", { introduced: F45 })
        ]
      },
      { name: "keybind_down", introduced: F45, fields: [field("keybind", "string", { required: true })] },
      { name: "selected", introduced: F44, fields: [] },
      { name: "shift_down", introduced: F44, removed: F45, fields: [] },
      { name: "using_item", introduced: F44, fields: [] },
      { name: "view_entity", introduced: F46, fields: [] },
      { name: "xmas", introduced: F44, removed: F45, fields: [] }
    ]
  },
  select: {
    commonFields: [],
    properties: [
      {
        name: "block_state",
        introduced: F44,
        fields: [field("block_state_property", "string", { required: true })]
      },
      {
        name: "charge_type",
        introduced: F44,
        fields: [],
        whenValueKind: "enum",
        whenValues: ["none", "arrow", "rocket", "firework", "firework_rocket"]
      },
      {
        name: "component",
        introduced: F48,
        fields: [field("component", "resourceId", { required: true })],
        whenValueKind: "json"
      },
      {
        name: "context_dimension",
        introduced: F46,
        fields: [],
        whenValueKind: "resourceId"
      },
      {
        name: "context_entity_type",
        introduced: F46,
        fields: [],
        whenValueKind: "resourceId"
      },
      { name: "custom_model_data", introduced: F44, fields: [field("index", "nonNegativeInteger")] },
      {
        name: "display_context",
        introduced: F44,
        fields: [],
        whenValueKind: "enum",
        whenVariants: [
          {
            introduced: F44,
            value: {
              values: [
                "none",
                "thirdperson_lefthand",
                "thirdperson_righthand",
                "firstperson_lefthand",
                "firstperson_righthand",
                "head",
                "gui",
                "ground",
                "fixed"
              ]
            }
          },
          {
            introduced: F65_2,
            value: {
              values: [
                "none",
                "thirdperson_lefthand",
                "thirdperson_righthand",
                "firstperson_lefthand",
                "firstperson_righthand",
                "head",
                "gui",
                "ground",
                "fixed",
                "on_shelf"
              ]
            }
          }
        ]
      },
      {
        name: "holder_type",
        introduced: F45,
        removed: F46,
        fields: [],
        whenValueKind: "resourceId"
      },
      {
        name: "local_time",
        introduced: F45,
        fields: [
          field("locale", "string"),
          field("pattern", "string", { required: true }),
          field("time_zone", "string")
        ]
      },
      {
        name: "main_hand",
        introduced: F44,
        fields: [],
        whenValueKind: "enum",
        whenValues: ["left", "right"]
      },
      {
        name: "potion_contents",
        introduced: F44,
        removed: F48,
        fields: [field("component", "resourceId")],
        whenValueKind: "resourceId"
      },
      {
        name: "trim_material",
        introduced: F44,
        fields: [],
        whenValueKind: "resourceId"
      }
    ]
  },
  range_dispatch: {
    commonFields: [field("scale", "finiteNumber")],
    properties: [
      { name: "bundle/fullness", introduced: F44, fields: [] },
      {
        name: "compass",
        introduced: F44,
        fields: [
          field("target", "enum", {
            required: true,
            removed: F46,
            values: ["spawn", "lodestone", "recovery"]
          }),
          field("target", "enum", {
            introduced: F46,
            required: true,
            values: ["spawn", "lodestone", "recovery", "none"]
          }),
          field("wobble", "boolean")
        ]
      },
      { name: "cooldown", introduced: F44, fields: [] },
      { name: "count", introduced: F44, fields: [field("normalize", "boolean")] },
      { name: "crossbow/pull", introduced: F44, fields: [] },
      { name: "custom_model_data", introduced: F44, fields: [field("index", "nonNegativeInteger")] },
      { name: "damage", introduced: F44, fields: [field("normalize", "boolean")] },
      {
        name: "time",
        introduced: F44,
        fields: [
          field("natural_only", "boolean", {
            introduced: F44,
            removed: F46
          }),
          field("source", "enum", {
            introduced: F46,
            required: true,
            values: ["daytime", "moon_phase", "random"]
          }),
          field("wobble", "boolean")
        ]
      },
      { name: "use_cycle", introduced: F44, fields: [field("period", "positiveNumber")] },
      { name: "use_duration", introduced: F44, fields: [field("remaining", "boolean")] }
    ]
  }
};

const allConditionOptions = conditionPropertyFields.map(rule => rule.name);
const allSelectOptions = selectPropertyFields.map(rule => rule.name);
const allRangeOptions = [
  ...rangePropertyFields.map(rule => rule.name),
  "scale"
];

/**
 * Parser/completion vocabulary is deliberately target-neutral. Target
 * availability belongs to validation, not syntax recognition.
 */
export const itemModelPropertyOptionVocabulary = {
  condition: allConditionOptions,
  select: allSelectOptions,
  range_dispatch: allRangeOptions
} as const;

const propertyOptionsFor = (
  family: keyof typeof itemModelPropertySchemas
): readonly string[] => itemModelPropertyOptionVocabulary[family];

export const itemModelNodeSchemas: readonly ItemModelNodeSchema[] = [
  {
    name: "model",
    introduced: F44,
    requiredFields: ["model"],
    allowedFields: ["type", "model", "tints", "transformation"],
    allowsTints: true,
    allowsTransformation: true
  },
  {
    name: "composite",
    introduced: F44,
    requiredFields: ["models"],
    allowedFields: ["type", "models", "transformation"],
    allowsTransformation: true
  },
  {
    name: "condition",
    introduced: F44,
    requiredFields: ["property", "on_true", "on_false"],
    allowedFields: [
      "type", "property", "on_true", "on_false", "transformation",
      ...propertyOptionsFor("condition")
    ],
    allowsTransformation: true
  },
  {
    name: "select",
    introduced: F44,
    requiredFields: ["property", "cases"],
    allowedFields: [
      "type", "property", "cases", "fallback", "transformation",
      ...propertyOptionsFor("select")
    ],
    allowsTransformation: true
  },
  {
    name: "range_dispatch",
    introduced: F44,
    requiredFields: ["property", "entries"],
    allowedFields: [
      "type", "property", "entries", "fallback", "transformation",
      ...propertyOptionsFor("range_dispatch")
    ],
    allowsTransformation: true
  },
  {
    name: "empty",
    introduced: F46,
    requiredFields: [],
    allowedFields: ["type"]
  },
  {
    name: "bundle/selected_item",
    introduced: F44,
    requiredFields: [],
    allowedFields: ["type"]
  },
  {
    name: "special",
    introduced: F44,
    requiredFields: ["base", "model"],
    allowedFields: ["type", "base", "model", "transformation"],
    allowsTransformation: true
  }
];

export const itemModelTintSchemas: readonly ItemModelObjectSchema[] = [
  {
    name: "constant",
    introduced: F44,
    fields: [field("value", "color", { required: true })]
  },
  {
    name: "dye",
    introduced: F44,
    fields: [field("default", "color", { required: true })]
  },
  {
    name: "firework",
    introduced: F44,
    fields: [field("default", "color", { required: true })]
  },
  {
    name: "grass",
    introduced: F44,
    fields: [
      field("temperature", "numberInUnitRange", { required: true }),
      field("downfall", "numberInUnitRange", { required: true })
    ]
  },
  {
    name: "map_color",
    introduced: F44,
    fields: [field("default", "color", { required: true })]
  },
  {
    name: "potion",
    introduced: F44,
    fields: [field("default", "color", { required: true })]
  },
  {
    name: "team",
    introduced: F46,
    fields: [field("default", "color", { required: true })]
  },
  {
    name: "custom_model_data",
    introduced: F44,
    fields: [
      field("default", "color", { required: true }),
      field("index", "nonNegativeInteger")
    ]
  }
];

const special = (
  name: string,
  fields: readonly ItemModelFieldSchema[],
  lifecycle: ItemModelSchemaLifecycle = {},
  variants?: readonly ItemModelSchemaVariant<{ readonly fields: readonly ItemModelFieldSchema[] }>[]
): ItemModelSpecialSchema => ({
  name,
  ...lifecycle,
  variants: variants ?? [{ introduced: lifecycle.introduced ?? F44, value: { fields } }]
});

export const itemModelSpecialSchemas: readonly ItemModelSpecialSchema[] = [
  special("banner", [], { introduced: F44 }, [
    {
      introduced: F44,
      value: { fields: [field("color", "enum", { required: true, values: dyeColors })] }
    },
    {
      introduced: F83,
      value: {
        fields: [
          field("attachment", "enum", { values: ["ground", "wall"] }),
          field("color", "enum", { required: true, values: dyeColors })
        ]
      }
    }
  ]),
  special("bed", [], { introduced: F44, removed: F86 }, [
    {
      introduced: F44,
      value: { fields: [field("texture", "string", { required: true })] }
    },
    {
      introduced: F83,
      value: {
        fields: [
          field("part", "enum", { required: true, values: ["head", "foot"] }),
          field("texture", "string", { required: true })
        ]
      }
    }
  ]),
  special("bell", [], { introduced: F83 }),
  special("book", [
    field("open_angle", "finiteNumber", { required: true }),
    field("page1", "numberInUnitRange", { required: true }),
    field("page2", "numberInUnitRange", { required: true })
  ], { introduced: F83 }),
  special("chest", [], { introduced: F44 }, [
    {
      introduced: F44,
      value: {
        fields: [
          field("openness", "numberInUnitRange"),
          field("texture", "string", { required: true })
        ]
      }
    },
    {
      introduced: F83,
      value: {
        fields: [
          field("chest_type", "enum", { values: ["single", "left", "right"] }),
          field("openness", "numberInUnitRange"),
          field("texture", "string", { required: true })
        ]
      }
    }
  ]),
  special("conduit", [], { introduced: F44 }),
  special("copper_golem_statue", [
    field("pose", "enum", { required: true, values: ["standing", "sitting", "running", "star"] }),
    field("texture", "string", { required: true })
  ], { introduced: F65 }),
  special("decorated_pot", [], { introduced: F44 }),
  special("end_cube", [
    field("effect", "enum", { required: true, values: ["gateway", "portal"] })
  ], { introduced: F84 }),
  special("hanging_sign", [], { introduced: F45, removed: F87 }, [
    {
      introduced: F45,
      value: {
        fields: [
          field("texture", "string"),
          field("wood_type", "enum", { required: true, values: woodTypes })
        ]
      }
    },
    {
      introduced: F83,
      value: {
        fields: [
          field("attachment", "enum", { values: ["wall", "ceiling", "ceiling_middle"] }),
          field("texture", "string"),
          field("wood_type", "enum", { required: true, values: woodTypes })
        ]
      }
    }
  ]),
  special("head", [], { introduced: F44 }, [
    {
      introduced: F44,
      value: {
        fields: [
          field("kind", "enum", {
            required: true,
            values: ["skeleton", "wither_skeleton", "player", "zombie", "creeper", "piglin", "dragon"]
          })
        ]
      }
    },
    {
      introduced: F45,
      value: {
        fields: [
          field("kind", "enum", {
            required: true,
            values: ["skeleton", "wither_skeleton", "player", "zombie", "creeper", "piglin", "dragon"]
          }),
          field("texture", "string")
        ]
      }
    },
    {
      introduced: F46,
      value: {
        fields: [
          field("animation", "finiteNumber"),
          field("kind", "enum", {
            required: true,
            values: ["skeleton", "wither_skeleton", "player", "zombie", "creeper", "piglin", "dragon"]
          }),
          field("texture", "string")
        ]
      }
    }
  ]),
  special("player_head", [], { introduced: F63 }),
  special("shield", [], { introduced: F44 }),
  special("shulker_box", [], { introduced: F44 }, [
    {
      introduced: F44,
      value: {
        fields: [
          field("openness", "numberInUnitRange"),
          field("orientation", "enum", {
            values: ["down", "up", "north", "south", "west", "east"]
          }),
          field("texture", "string", { required: true })
        ]
      }
    },
    {
      introduced: F83,
      value: {
        fields: [
          field("openness", "numberInUnitRange"),
          field("texture", "string", { required: true })
        ]
      }
    }
  ]),
  special("standing_sign", [], { introduced: F45, removed: F87 }, [
    {
      introduced: F45,
      value: {
        fields: [
          field("texture", "string"),
          field("wood_type", "enum", { required: true, values: woodTypes })
        ]
      }
    },
    {
      introduced: F83,
      value: {
        fields: [
          field("attachment", "enum", { values: ["wall", "ground"] }),
          field("texture", "string"),
          field("wood_type", "enum", { required: true, values: woodTypes })
        ]
      }
    }
  ]),
  special("trident", [], { introduced: F44 })
];

export function findItemModelNodeSchema(name: string): ItemModelNodeSchema | undefined {
  return itemModelNodeSchemas.find(schema => schema.name === name);
}

export function findItemModelPropertySchema(
  family: keyof typeof itemModelPropertySchemas,
  name: string
): ItemModelPropertySchema | undefined {
  return itemModelPropertySchemas[family].properties.find(schema => schema.name === name);
}

export function findItemModelTintSchema(name: string): ItemModelObjectSchema | undefined {
  return itemModelTintSchemas.find(schema => schema.name === name);
}

export function findItemModelSpecialSchema(name: string): ItemModelSpecialSchema | undefined {
  return itemModelSpecialSchemas.find(schema => schema.name === name);
}

export function itemModelSpecialVariantsForTarget(
  schema: ItemModelSpecialSchema,
  target: ItemModelFormat | undefined
): readonly { readonly fields: readonly ItemModelFieldSchema[] }[] {
  if (!isItemModelSchemaEntryAvailable(schema, target)) {
    return [];
  }
  return projectItemModelSchemaVariants(schema.variants, target);
}

export function itemModelSchemaAvailabilityMessage(
  subject: string,
  lifecycle: ItemModelSchemaLifecycle,
  target: ItemModelFormat
): string {
  const renderedTarget = target[0] + "." + target[1];
  if (lifecycle.introduced && compareItemModelFormats(target, lifecycle.introduced) < 0) {
    return subject + " requires pack format " + lifecycle.introduced[0] + "." + lifecycle.introduced[1]
      + " or newer (target is " + renderedTarget + ").";
  }
  if (lifecycle.removed && compareItemModelFormats(target, lifecycle.removed) >= 0) {
    return subject + " was removed in pack format " + lifecycle.removed[0] + "." + lifecycle.removed[1]
      + " (target is " + renderedTarget + ").";
  }
  return subject + " is not supported by target pack format " + renderedTarget + ".";
}

let cachedHistoricalFormats: readonly ItemModelFormat[] | undefined;

/**
 * Returns one representative target for every schema-history interval.
 *
 * Consumers use these targets to answer target-neutral whole-shape questions:
 * a JSON shape is historically valid only when one representative target
 * accepts all of its version-sensitive parts together. The list is derived
 * solely from registry lifecycle and variant events, so adding an event to the
 * schema automatically creates the corresponding validation interval.
 */
export function itemModelHistoricalFormats(): readonly ItemModelFormat[] {
  if (cachedHistoricalFormats) {
    return cachedHistoricalFormats;
  }
  const formats = new Map<string, ItemModelFormat>();
  const addFormat = (format: ItemModelFormat | undefined): void => {
    if (format) {
      formats.set(format[0] + "." + format[1], format);
    }
  };
  const addLifecycle = (lifecycle: ItemModelSchemaLifecycle): void => {
    addFormat(lifecycle.introduced);
    addFormat(lifecycle.removed);
  };
  const addFields = (fields: readonly ItemModelFieldSchema[]): void => {
    for (const rule of fields) {
      addLifecycle(rule);
    }
  };

  addLifecycle(itemModelTransformationSchema);
  addFields(itemModelRootFields);
  for (const schema of itemModelNodeSchemas) {
    addLifecycle(schema);
  }
  for (const family of Object.values(itemModelPropertySchemas)) {
    addFields(family.commonFields);
    for (const property of family.properties) {
      addLifecycle(property);
      addFields(property.fields);
      for (const variant of property.whenVariants ?? []) {
        addFormat(variant.introduced);
      }
    }
  }
  for (const schema of itemModelTintSchemas) {
    addLifecycle(schema);
    addFields(schema.fields);
  }
  for (const schema of itemModelSpecialSchemas) {
    addLifecycle(schema);
    for (const variant of schema.variants) {
      addFormat(variant.introduced);
      addFields(variant.value.fields);
    }
  }

  cachedHistoricalFormats = [...formats.values()].sort(compareItemModelFormats);
  return cachedHistoricalFormats;
}
