import { uniqueValues } from "../../mc-assets/src";
import type { RsglCompletionCandidate } from "./completionData";
import type { RsglItemModelCompletionContext } from "./itemModelCompletionContext";
import {
  compareItemModelFormats,
  findItemModelNodeSchema,
  findItemModelPropertySchema,
  findItemModelSpecialSchema,
  findItemModelTintSchema,
  isItemModelSchemaEntryAvailable,
  itemModelPropertySchemas,
  itemModelRootFields,
  itemModelSpecialSchemas,
  itemModelSpecialVariantsForTarget,
  itemModelTintSchemas,
  projectItemModelSchemaVariants,
  type ItemModelFieldSchema,
  type ItemModelFormat
} from "./itemModelSchema";
import {
  rsglItemModelBodyDescriptors,
  rsglItemModelConstructorDescriptors
} from "./itemModelSyntax";

interface ItemModelCompletionRequest {
  itemModel?: RsglItemModelCompletionContext;
  targetFormat?: ItemModelFormat;
  allowBase: boolean;
}

export interface ItemModelCompletionDependencies {
  builtinCompletions: readonly RsglCompletionCandidate[];
  resourceRootOperationCompletions: readonly RsglCompletionCandidate[];
}

const itemModelControlOwners = new Set<string>(
  rsglItemModelBodyDescriptors
    .filter(descriptor => descriptor.controlClauses.length > 0)
    .map(descriptor => descriptor.owner)
);

function itemModelConstructorCompletions(
  target: ItemModelFormat | undefined
): RsglCompletionCandidate[] {
  return rsglItemModelConstructorDescriptors
    .filter(descriptor => {
      const schema = findItemModelNodeSchema(itemModelSchemaNameForConstructor(descriptor.keyword));
      return schema !== undefined && isItemModelSchemaEntryAvailable(schema, target);
    })
    .map(descriptor => ({
    label: descriptor.keyword,
    insertText: descriptor.canonicalSnippet,
    detail: descriptor.detail,
    kind: "snippet" as const
    }));
}

const itemModelControlCompletions: readonly RsglCompletionCandidate[] = [
  { label: "let", insertText: "let ${1:name} = ${2:value}", detail: "Item-model local constant", kind: "snippet" },
  { label: "for", insertText: "for ${1:item} in ${2:items} {\n  ${3}\n}", detail: "Finite item-model expansion", kind: "snippet" },
  { label: "if", insertText: "if ${1:condition} {\n  ${2}\n}", detail: "Compile-time item-model branch", kind: "snippet" }
];

function itemModelValueCompletions(target: ItemModelFormat | undefined): RsglCompletionCandidate[] {
  return [
    ...itemModelConstructorCompletions(target),
    {
    label: "use item_model",
    insertText: "use ${1:templateName}(${2})",
    detail: "Call an item_model template",
    kind: "snippet"
    }
  ];
}

function itemModelRootOperationCompletions(
  target: ItemModelFormat | undefined
): RsglCompletionCandidate[] {
  return [
    { label: "model", insertText: "model ${1:minecraft:item/model}", detail: "Direct item-model expression producer", kind: "snippet" },
    ...itemModelConstructorCompletions(target),
    {
      label: "use item_model",
      insertText: "use ${1:templateName}(${2})",
      detail: "Produce the root model from an item_model template",
      kind: "snippet"
    },
    ...itemModelControlCompletions
  ];
}

const itemModelOptionCompletions = {
  modelLeafOptions: [
    {
      label: "tints",
      insertText: "tints: [{ type: ${1:minecraft:constant}, value: ${2:-1} }]",
      detail: "Ordered tint-source list",
      kind: "property" as const
    },
    {
      label: "transformation",
      insertText: "transformation: { translation: [${1:0}, ${2:0}, ${3:0}] }",
      detail: "Item-model transformation",
      kind: "property" as const
    }
  ],
  transformOptions: [{
    label: "transformation",
    insertText: "transformation: { translation: [${1:0}, ${2:0}, ${3:0}] }",
    detail: "Item-model transformation",
    kind: "property" as const
  }]
} satisfies Record<"modelLeafOptions" | "transformOptions", readonly RsglCompletionCandidate[]>;

export function getItemModelCompletionCandidates(
  request: ItemModelCompletionRequest,
  dependencies: ItemModelCompletionDependencies
): RsglCompletionCandidate[] {
  const itemContext = request.itemModel ?? {
    scope: "itemModelTemplate" as const,
    owner: "itemModelTemplate" as const,
    expectedSlot: "producer" as const
  };
  if (itemContext.schema) {
    return itemModelSchemaCompletions(
      itemContext.schema,
      request.targetFormat,
      dependencies.builtinCompletions
    );
  }
  if (itemContext.optionOwner) {
    return itemContext.optionKeyPosition === false
      ? [...dependencies.builtinCompletions]
      : itemModelPostfixOptionCompletions(
          itemContext.optionOwner,
          request.targetFormat,
          itemContext.writtenOptionKeys ?? []
        );
  }
  if (itemContext.expectedSlot === "itemModel") {
    return [...itemModelValueCompletions(request.targetFormat), ...dependencies.builtinCompletions];
  }
  if (itemContext.expectedSlot === "producer") {
    const rootJson = itemContext.scope === "itemRoot"
      ? itemRootJsonCompletions(
          request.targetFormat,
          dependencies.resourceRootOperationCompletions
        ).filter(candidate => candidate.label !== "base" || request.allowBase)
      : [];
    return [
      ...itemModelRootOperationCompletions(request.targetFormat),
      ...rootJson,
      ...dependencies.builtinCompletions
    ];
  }
  return [
    ...itemModelClauseCompletions(itemContext.owner),
    ...(itemModelControlOwners.has(itemContext.owner) ? itemModelControlCompletions : []),
    ...dependencies.builtinCompletions
  ];
}

function itemModelSchemaNameForConstructor(keyword: string): string {
  if (keyword === "range") {
    return "range_dispatch";
  }
  if (keyword === "selected_item") {
    return "bundle/selected_item";
  }
  if (keyword === "first_match") {
    return "condition";
  }
  return keyword;
}

function itemRootJsonCompletions(
  target: ItemModelFormat | undefined,
  resourceRootOperationCompletions: readonly RsglCompletionCandidate[]
): RsglCompletionCandidate[] {
  const rootFields = itemModelRootFields
    .filter(field => field.name !== "model" && isItemModelSchemaEntryAvailable(field, target))
    .map(field => schemaFieldCandidate(field, "statement"));
  return [...rootFields, ...resourceRootOperationCompletions];
}

function itemModelPostfixOptionCompletions(
  owner: "modelLeafOptions" | "transformOptions",
  target: ItemModelFormat | undefined,
  writtenKeys: readonly string[]
): RsglCompletionCandidate[] {
  const written = new Set(writtenKeys);
  const supportsItemModels = !target || compareItemModelFormats(target, [44, 0]) >= 0;
  const supportsTransformation = !target || compareItemModelFormats(target, [83, 0]) >= 0;
  return itemModelOptionCompletions[owner].filter(candidate =>
    !written.has(candidate.label)
    && (candidate.label !== "tints" || supportsItemModels)
    && (candidate.label !== "transformation" || supportsTransformation)
  );
}

function itemModelSchemaCompletions(
  schema: NonNullable<RsglItemModelCompletionContext["schema"]>,
  target: ItemModelFormat | undefined,
  builtinCompletions: readonly RsglCompletionCandidate[]
): RsglCompletionCandidate[] {
  switch (schema.kind) {
    case "propertyName":
      return itemModelPropertySchemas[schema.family].properties
        .filter(property => isItemModelSchemaEntryAvailable(property, target))
        .map(property => ({
          label: `minecraft:${property.name}`,
          insertText: `minecraft:${property.name}`,
          detail: `${schema.family} item-model property`,
          kind: "constant" as const
        }));
    case "propertyOptionName":
      return propertyFields(schema.family, schema.propertyName, target)
        .filter(field => !schema.writtenKeys.includes(field.name))
        .map(field => schemaFieldCandidate(field, "header"));
    case "propertyOptionValue":
      return enumValueCandidates(
        propertyFields(schema.family, schema.propertyName, target)
          .filter(field => field.name === schema.optionName)
          .flatMap(field => field.values ?? []),
        false,
        `Value for ${schema.optionName}`
      );
    case "selectWhen": {
      const property = schema.propertyName
        ? findItemModelPropertySchema("select", schema.propertyName)
        : undefined;
      if (!property || !isItemModelSchemaEntryAvailable(property, target)) {
        return [...builtinCompletions];
      }
      const values = property.whenVariants
        ? projectItemModelSchemaVariants(property.whenVariants, target).flatMap(variant => variant.values)
        : [...(property.whenValues ?? [])];
      return values.length > 0
        ? enumValueCandidates(values, true, `Case value for minecraft:${property.name}`)
        : [...builtinCompletions];
    }
    case "specialType":
      return itemModelSpecialSchemas
        .filter(item => isItemModelSchemaEntryAvailable(item, target))
        .map(item => ({
          label: `minecraft:${item.name}`,
          insertText: `minecraft:${item.name}`,
          detail: "Special item renderer subtype",
          kind: "constant" as const
        }));
    case "specialFieldName": {
      const fields = specialFields(schema.subtype, target);
      return [requiredTypeField(), ...fields.map(field => schemaFieldCandidate(field, "object"))]
        .filter(candidate => !schema.writtenKeys.includes(candidate.label));
    }
    case "specialFieldValue":
      return objectFieldValueCompletions(
        specialFields(schema.subtype, target),
        schema.fieldName,
        builtinCompletions
      );
    case "tintType":
      return itemModelTintSchemas
        .filter(item => isItemModelSchemaEntryAvailable(item, target))
        .map(item => ({
          label: `minecraft:${item.name}`,
          insertText: `minecraft:${item.name}`,
          detail: "Item tint-source subtype",
          kind: "constant" as const
        }));
    case "tintFieldName": {
      const tint = schema.subtype ? findItemModelTintSchema(schema.subtype) : undefined;
      const fields = tint && isItemModelSchemaEntryAvailable(tint, target)
        ? tint.fields.filter(field => isItemModelSchemaEntryAvailable(field, target))
        : [];
      return [requiredTypeField(), ...fields.map(field => schemaFieldCandidate(field, "object"))]
        .filter(candidate => !schema.writtenKeys.includes(candidate.label));
    }
    case "tintFieldValue": {
      const tint = schema.subtype ? findItemModelTintSchema(schema.subtype) : undefined;
      return objectFieldValueCompletions(
        tint?.fields ?? [],
        schema.fieldName,
        builtinCompletions
      );
    }
    case "transformationFieldName":
      if (target && compareItemModelFormats(target, [83, 0]) < 0) {
        return [];
      }
      return [
        schemaVectorCandidate("right_rotation", "[0, 0, 0, 1]"),
        schemaVectorCandidate("translation", "[0, 0, 0]"),
        schemaVectorCandidate("left_rotation", "[0, 0, 0, 1]"),
        schemaVectorCandidate("scale", "[1, 1, 1]")
      ].filter(candidate => !schema.writtenKeys.includes(candidate.label));
    case "rotationFieldName":
      return [
        schemaVectorCandidate("axis", "[0, 1, 0]"),
        {
          label: "angle",
          insertText: "angle: ${1:0}",
          detail: "Finite rotation angle in radians",
          kind: "property" as const
        }
      ].filter(candidate => !schema.writtenKeys.includes(candidate.label));
    default:
      return assertNeverSchemaCompletion(schema);
  }
}

function propertyFields(
  family: keyof typeof itemModelPropertySchemas,
  propertyName: string | undefined,
  target: ItemModelFormat | undefined
): ItemModelFieldSchema[] {
  const familySchema = itemModelPropertySchemas[family];
  const property = propertyName ? findItemModelPropertySchema(family, propertyName) : undefined;
  const candidates = property
    ? [...familySchema.commonFields, ...property.fields]
    : [
        ...familySchema.commonFields,
        ...familySchema.properties.flatMap(item => item.fields)
      ];
  return uniqueFields(candidates.filter(field => isItemModelSchemaEntryAvailable(field, target)));
}

function specialFields(
  subtype: string | undefined,
  target: ItemModelFormat | undefined
): ItemModelFieldSchema[] {
  const special = subtype ? findItemModelSpecialSchema(subtype) : undefined;
  if (!special) {
    return [];
  }
  return uniqueFields(
    itemModelSpecialVariantsForTarget(special, target)
      .flatMap(variant => variant.fields)
      .filter(field => isItemModelSchemaEntryAvailable(field, target))
  );
}

function uniqueFields(fields: readonly ItemModelFieldSchema[]): ItemModelFieldSchema[] {
  const byName = new Map<string, ItemModelFieldSchema>();
  for (const field of fields) {
    byName.set(field.name, field);
  }
  return [...byName.values()];
}

function schemaFieldCandidate(
  field: ItemModelFieldSchema,
  surface: "statement" | "header" | "object"
): RsglCompletionCandidate {
  const separator = surface === "object" ? ": " : " ";
  return {
    label: field.name,
    insertText: `${field.name}${separator}${fieldValueSnippet(field)}`,
    detail: `${field.required ? "Required " : "Optional "}${field.kind} item-model field`,
    kind: "property"
  };
}

function fieldValueSnippet(field: ItemModelFieldSchema): string {
  if (field.kind === "boolean") {
    return "${1:true}";
  }
  if (field.kind === "string") {
    return "\"${1:value}\"";
  }
  if (field.kind === "resourceId") {
    return "${1:minecraft:value}";
  }
  if (field.kind === "color") {
    return "${1:-1}";
  }
  if (field.kind === "enum" && field.values?.length) {
    return `\${1|${field.values.join(",")}|}`;
  }
  return "${1:value}";
}

function enumValueCandidates(
  values: readonly string[],
  quoted: boolean,
  detail: string
): RsglCompletionCandidate[] {
  return uniqueValues(values).map(value => ({
    label: quoted ? `"${value}"` : value,
    insertText: quoted ? `"${value}"` : value,
    detail,
    kind: "constant"
  }));
}

function objectFieldValueCompletions(
  fields: readonly ItemModelFieldSchema[],
  fieldName: string,
  builtinCompletions: readonly RsglCompletionCandidate[]
): RsglCompletionCandidate[] {
  const values = fields
    .filter(field => field.name === fieldName)
    .flatMap(field => field.values ?? []);
  return values.length > 0
    ? enumValueCandidates(values, false, `Value for ${fieldName}`)
    : [...builtinCompletions];
}

function requiredTypeField(): RsglCompletionCandidate {
  return {
    label: "type",
    insertText: "type: ${1:minecraft:type}",
    detail: "Required item-model subtype discriminator",
    kind: "property"
  };
}

function schemaVectorCandidate(label: string, value: string): RsglCompletionCandidate {
  return {
    label,
    insertText: `${label}: ${value}`,
    detail: "Item-model transformation component",
    kind: "property"
  };
}

function assertNeverSchemaCompletion(value: never): never {
  throw new Error(`Unhandled item-model schema completion: ${JSON.stringify(value)}`);
}

function itemModelClauseCompletions(
  owner: RsglItemModelCompletionContext["owner"]
): readonly RsglCompletionCandidate[] {
  switch (owner) {
    case "select":
      return [
        { label: "case", insertText: "case ${1:value} => ${2:minecraft:item/model}", detail: "Select case", kind: "snippet" },
        { label: "fallback", insertText: "fallback ${1:minecraft:item/model}", detail: "Select fallback", kind: "snippet" }
      ];
    case "range":
      return [
        { label: "entry", insertText: "entry ${1:0} => ${2:minecraft:item/model}", detail: "Range entry", kind: "snippet" },
        { label: "frames", insertText: "frames ${1:0..15} model ${2:minecraft:item/model}", detail: "Bulk range entries", kind: "snippet" },
        { label: "fallback", insertText: "fallback ${1:minecraft:item/model}", detail: "Range fallback", kind: "snippet" }
      ];
    case "composite":
      return [{ label: "model", insertText: "model ${1:minecraft:item/model}", detail: "Composite child model", kind: "snippet" }];
    case "first_match":
      return [
        { label: "when", insertText: "when property ${1:minecraft:using_item} => ${2:minecraft:item/model}", detail: "Ordered condition predicate", kind: "snippet" },
        { label: "fallback", insertText: "fallback ${1:minecraft:item/model}", detail: "Required first_match fallback", kind: "snippet" }
      ];
    case "condition":
      return [
        { label: "on_true", insertText: "on_true ${1:minecraft:item/active}", detail: "Condition true model", kind: "snippet" },
        { label: "on_false", insertText: "on_false ${1:minecraft:item/inactive}", detail: "Condition false model", kind: "snippet" }
      ];
    case "itemRoot":
    case "itemModelTemplate":
    case "modelLeaf":
    case "special":
      return [];
    default:
      return [];
  }
}
