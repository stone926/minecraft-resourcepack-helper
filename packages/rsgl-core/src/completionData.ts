import {
  rsglExternResourceCompletionDescriptors,
  rsglResourceCompletionDescriptors
} from "./resourceKinds";
import { rsglModelGeometryCompletionDescriptors } from "./modelGeometrySyntax";
import {
  getRsglCompletionContext,
  type RsglCompletionContext
} from "./completionContext";
import { getItemModelCompletionCandidates } from "./itemModelCompletionData";
import {
  blockstateChoiceCompletions,
  blockstateModelOptionCompletions,
  blockstatePredicateCompletions,
  getBlockstateEntryCompletions
} from "./blockstateCompletionData";
import {
  rsglResourceIdConstructors,
  typeKindForResourceValueKind
} from "./resourceIdSemantics";

export interface RsglCompletionCandidate {
  label: string;
  insertText?: string;
  detail: string;
  kind: "keyword" | "snippet" | "function" | "constant" | "property";
}

export const topLevelRsglCompletions: RsglCompletionCandidate[] = [
  {
    label: "target",
    insertText: "target java format [${1:88}, ${2:0}]",
    detail: "RSGL target declaration",
    kind: "snippet"
  },
  {
    label: "target mc",
    insertText: "target java mc \"${1:1.21.11}\"",
    detail: "RSGL target declaration by Minecraft version",
    kind: "snippet"
  },
  {
    label: "namespace",
    insertText: "namespace ${1:minecraft}",
    detail: "Default namespace declaration",
    kind: "snippet"
  },
  {
    label: "import",
    insertText: "import \"${1:./module.rsgl}\"",
    detail: "Import another RSGL module",
    kind: "snippet"
  },
  {
    label: "import namespace",
    insertText: "import * as ${1:common} from \"${2:./module.rsgl}\"",
    detail: "Import an RSGL module as a namespace",
    kind: "snippet"
  },
  {
    label: "export",
    insertText: "export { ${1:name} }",
    detail: "Export RSGL symbols",
    kind: "snippet"
  },
  {
    label: "let",
    insertText: "let ${1:name} = ${2:value}",
    detail: "Constant declaration",
    kind: "snippet"
  },
  {
    label: "table",
    insertText: "table ${1:name} {\n  ${2:key}: ${3:value}\n}",
    detail: "Structured lookup table",
    kind: "snippet"
  },
  {
    label: "template resources",
    insertText: "template ${1:name}(${2:id}: ResourceId) {\n  model block ${2:id} {\n    ${3}\n  }\n}",
    detail: "Complete-resource template",
    kind: "snippet"
  },
  {
    label: "template -> model",
    insertText: "template ${1:name}(${2:texture}: TextureRef) -> model {\n  ${3}\n}",
    detail: "Reusable model-body template",
    kind: "snippet"
  },
  {
    label: "template -> variants",
    insertText: "template ${1:name}(${2:model}: ModelId) -> variants {\n  case * => ${2:model}\n}",
    detail: "Reusable blockstate variants template",
    kind: "snippet"
  },
  {
    label: "template -> multipart",
    insertText: "template ${1:name}(${2:model}: ModelId) -> multipart {\n  part always => ${2:model}\n}",
    detail: "Reusable blockstate multipart template",
    kind: "snippet"
  },
  {
    label: "template -> choice",
    insertText: "template ${1:name}(${2:model}: ModelId) -> choice {\n  option ${2:model}\n}",
    detail: "Reusable random blockstate choice fragment",
    kind: "snippet"
  },
  {
    label: "template -> item_model",
    insertText: "template ${1:name}(${2:model}: ModelId) -> item_model {\n  model ${2:model}\n}",
    detail: "Reusable cardinality-one item-model template",
    kind: "snippet"
  },
  ...rsglExternResourceCompletionDescriptors.map(descriptor => ({
    ...descriptor,
    kind: "snippet" as const
  })),
  ...rsglResourceCompletionDescriptors.map(descriptor => ({
    ...descriptor,
    kind: "snippet" as const
  })),
  {
    label: "overlay",
    insertText: "overlay \"${1:future}\" format [${2:89}, ${3:0}]..[${4:90}, ${5:0}] {\n  ${6}\n}",
    detail: "Overlay output target",
    kind: "snippet"
  },
  {
    label: "model block impl",
    insertText: "model block ${1:stone} impl minecraft:block/cube_all(all: minecraft:block/${1:stone}) {\n  ${2}\n}",
    detail: "Declare a block model using a vanilla parent",
    kind: "snippet"
  },
  {
    label: "model item impl",
    insertText: "model item ${1:diamond} impl minecraft:item/generated(layer0: minecraft:item/${1:diamond}) {\n  ${2}\n}",
    detail: "Declare an item model using a vanilla parent",
    kind: "snippet"
  },
  {
    label: "item model",
    insertText: "item ${1:diamond} {\n  model minecraft:item/${1:diamond}\n}",
    detail: "Declare an item definition model mapping",
    kind: "snippet"
  },
  {
    label: "import item conventions",
    insertText: "import { ${1:generatedItem} } from \"rsgl:conventions/items.rsgl\"",
    detail: "Import RSGL item/model convention templates",
    kind: "snippet"
  },
  {
    label: "import blockstate conventions",
    insertText: "import { ${1:stairsBlockstate} } from \"rsgl:conventions/blockstates.rsgl\"",
    detail: "Import RSGL blockstate convention templates",
    kind: "snippet"
  },
  {
    label: "import blockstate templates",
    insertText: "import { ${1:stairs} } from \"rsgl:conventions/blockstate_fragments.rsgl\"",
    detail: "Import reusable RSGL blockstate templates",
    kind: "snippet"
  },
  {
    label: "use stairsBlockstate",
    insertText: "use stairsBlockstate(id: ${1:acacia_stairs})",
    detail: "Expand an imported stairs blockstate template",
    kind: "snippet"
  },
  {
    label: "use generatedItem",
    insertText: "use generatedItem(id: ${1:diamond}, layer0: minecraft:item/${1:diamond})",
    detail: "Expand an imported generated item convention template",
    kind: "snippet"
  }
];

export const blockRsglCompletions: RsglCompletionCandidate[] = [
  { label: "parent", insertText: "parent ${1:minecraft:block/cube_all}", detail: "Model parent", kind: "property" },
  { label: "extern var", insertText: "extern var #${1:front}, #${2:back}", detail: "Declare texture variables supplied by child models", kind: "snippet" },
  { label: "texture", insertText: "texture ${1:all} ${2:minecraft:block/stone}", detail: "Model texture variable", kind: "snippet" },
  { label: "textures", insertText: "textures {\n  ${1:all}: ${2:minecraft:block/stone}\n}", detail: "Model texture map", kind: "snippet" },
  ...rsglModelGeometryCompletionDescriptors.map(descriptor => ({
    ...descriptor,
    kind: "snippet" as const
  })),
  { label: "range", insertText: "range property ${1:minecraft:time} source ${2:daytime} wobble ${3:true} {\n  frames ${4:0..31} model ${5:minecraft:item/clock_00}\n  fallback ${6:minecraft:item/clock_00}\n}", detail: "Item range_dispatch model", kind: "snippet" },
  { label: "select", insertText: "select property ${1:minecraft:potion_contents} component ${2:minecraft:potion_contents} {\n  case ${3:\"minecraft:healing\"} => ${4:minecraft:item/potion_healing}\n  fallback ${5:minecraft:item/potion}\n}", detail: "Item select model", kind: "snippet" },
  { label: "condition", insertText: "condition property ${1:minecraft:using_item} {\n  on_true ${2:minecraft:item/bow_pulling}\n  on_false ${3:minecraft:item/bow}\n}", detail: "Item condition model", kind: "snippet" },
  { label: "composite", insertText: "composite {\n  model ${1:minecraft:item/base}\n  model ${2:minecraft:item/overlay}\n}", detail: "Item composite model", kind: "snippet" },
  { label: "special", insertText: "special base ${1:minecraft:item/shield} model { type: ${2:minecraft:shield} }", detail: "Item special model", kind: "snippet" },
  { label: "empty", insertText: "empty", detail: "Item empty model", kind: "snippet" },
  { label: "selected_item", insertText: "selected_item", detail: "Bundle selected item model", kind: "snippet" },
  { label: "let", insertText: "let ${1:name} = ${2:value}", detail: "Local constant", kind: "snippet" },
  { label: "use", insertText: "use ${1:templateName}(${2})", detail: "Template call", kind: "snippet" },
  { label: "for", insertText: "for ${1:item} in ${2:items} {\n  ${3}\n}", detail: "Finite expansion loop", kind: "snippet" },
  { label: "for multidim", insertText: "for ${1:a} in ${2:items}, ${3:b} in ${4:variants} {\n  ${5}\n}", detail: "Multidimensional finite expansion loop", kind: "snippet" },
  { label: "if", insertText: "if ${1:condition} {\n  ${2}\n}", detail: "Static conditional block", kind: "snippet" },
  { label: "base", insertText: "base \"${1:./resource.json}\"", detail: "Initialize this resource from a JSON document", kind: "snippet" },
  { label: "merge", insertText: "merge {\n  ${1:key}: ${2:value}\n}", detail: "Shallow-merge a JSON fragment", kind: "snippet" },
  { label: "merge deep", insertText: "merge deep {\n  ${1:key}: ${2:value}\n}", detail: "Recursively merge objects and append arrays", kind: "snippet" },
  { label: "merge strict", insertText: "merge strict {\n  ${1:key}: ${2:value}\n}", detail: "Merge only fields that already exist", kind: "snippet" },
  { label: "merge upsert", insertText: "merge upsert {\n  ${1:key}: ${2:value}\n}", detail: "Recursively update or create fields", kind: "snippet" },
  { label: "merge append", insertText: "merge append {\n  ${1:key}: [${2:value}]\n}", detail: "Recursively merge objects and append compatible arrays", kind: "snippet" }
];

const blockstateRootOnlyCompletions: readonly RsglCompletionCandidate[] = [
  {
    label: "custom",
    insertText: "${1:key}: ${2:value}",
    detail: "Custom blockstate root field",
    kind: "property"
  }
];

const blockstateControlLabels = new Set(["let", "use", "for", "for multidim", "if"]);
const blockstateRootOperationLabels = new Set([
  "base",
  "merge",
  "merge deep",
  "merge strict",
  "merge upsert",
  "merge append"
]);
const itemOnlyBlockCompletionLabels = new Set([
  "range",
  "select",
  "condition",
  "composite",
  "special",
  "empty",
  "selected_item"
]);

export const builtinRsglCompletions: RsglCompletionCandidate[] = [
  ...Object.entries(rsglResourceIdConstructors).map(([label, kind]) => ({
    label,
    insertText: `${label}(\${1:value})`,
    detail: `Construct a validated ${typeKindForResourceValueKind(kind)} value`,
    kind: "function" as const
  })),
  { label: "seq", insertText: "seq(${1:i} => \"minecraft:block/name_\" + ${1:i}, ${1:i}: ${2:0..3})", detail: "Compile-time string sequence", kind: "function" },
  { label: "atlasDirectory", detail: "Atlas directory source helper", kind: "function" },
  { label: "particlesSeq", insertText: "particlesSeq(\"${1:minecraft:particle/explosion_{0..2}}\", pad: ${2:0})", detail: "Particle texture sequence helper", kind: "function" },
  { label: "mcmetaAnimation", detail: "PNG animation metadata helper", kind: "function" },
  { label: "nineSliceGui", detail: "PNG GUI nine-slice metadata helper", kind: "function" },
  { label: "equipmentLayers", detail: "Equipment layer helper", kind: "function" },
  { label: "startsWith", insertText: "startsWith(${1:str}, ${2:prefix})", detail: "Compile-time string prefix predicate", kind: "function" },
  { label: "endsWith", insertText: "endsWith(${1:str}, ${2:suffix})", detail: "Compile-time string suffix predicate", kind: "function" },
  { label: "map", insertText: "map(${1:source}, ${2:item} => ${3:value})", detail: "Transform each collection item", kind: "function" },
  { label: "filter", insertText: "filter(${1:source}, ${2:item} => ${3:condition})", detail: "Keep collection items matching a Boolean predicate", kind: "function" },
  { label: "flatMap", insertText: "flatMap(${1:source}, ${2:item} => ${3:items})", detail: "Transform and flatten collection items", kind: "function" },
  { label: "concat", insertText: "concat(${1:sources})", detail: "Concatenate compile-time collections", kind: "function" },
  { label: "join", insertText: "join(${1:source}, ${2:separator})", detail: "Join a string list", kind: "function" },
  { label: "entries", insertText: "entries(${1:object})", detail: "List an object's key/value entries", kind: "function" },
  { label: "keys", insertText: "keys(${1:object})", detail: "List an object's keys", kind: "function" },
  { label: "values", insertText: "values(${1:object})", detail: "List an object's values", kind: "function" },
  { label: "mergeObjects", insertText: "mergeObjects(${1:objects})", detail: "Shallow-merge compile-time objects", kind: "function" },
  { label: "has", insertText: "has(${1:object}, ${2:key})", detail: "Test whether an object has a key", kind: "function" },
  { label: "replace", insertText: "replace(${1:str}, ${2:old}, ${3:new})", detail: "Compile-time string replacement", kind: "function" },
  { label: "padStart", insertText: "padStart(${1:str}, ${2:len}, ${3:pad})", detail: "Compile-time left padding", kind: "function" },
  { label: "padEnd", insertText: "padEnd(${1:str}, ${2:len}, ${3:pad})", detail: "Compile-time right padding", kind: "function" },
  { label: "resource_namespace", insertText: "resource_namespace(${1:id})", detail: "Extract a resource id namespace", kind: "function" },
  { label: "resource_path", insertText: "resource_path(${1:id})", detail: "Extract a resource id path", kind: "function" },
  { label: "lambda", insertText: "${1:value} => ${2:expression}", detail: "Compile-time expression mapper", kind: "snippet" },
  { label: "HORIZONTAL", detail: "Standard enum: north, east, south, west", kind: "constant" },
  { label: "DIRECTIONS", detail: "Standard enum: down, up, north, south, west, east", kind: "constant" },
  { label: "STAIR_SHAPES", detail: "Standard enum for stair shapes", kind: "constant" },
  { label: "COLORS_16", detail: "Standard Minecraft dye colors", kind: "constant" },
  { label: "true", detail: "Boolean literal", kind: "keyword" },
  { label: "false", detail: "Boolean literal", kind: "keyword" },
  { label: "null", detail: "Null literal", kind: "keyword" }
];

export function getRsglCompletionCandidates(text: string, offset: number): RsglCompletionCandidate[] {
  const context = getRsglCompletionContext(text, offset);
  return getRsglCompletionCandidatesForContext(context);
}

/** Builds candidates from an already parsed context for hot language-service paths. */
export function getRsglCompletionCandidatesForContext(
  context: RsglCompletionContext
): RsglCompletionCandidate[] {
  if (!context.insideBlock) {
    return [...topLevelRsglCompletions, ...builtinRsglCompletions];
  }
  if (context.itemModel || context.templateOutputDialect === "item_model") {
    return getItemModelCompletionCandidates(context, {
      builtinCompletions: builtinRsglCompletions,
      resourceRootOperationCompletions: blockRsglCompletions.filter(candidate =>
        blockstateRootOperationLabels.has(candidate.label)
      )
    });
  }
  if (context.blockstateModelOptions) {
    return [...blockstateModelOptionCompletions];
  }
  if (context.blockstatePredicate) {
    return [...blockstatePredicateCompletions, ...builtinRsglCompletions];
  }
  if (context.blockstateChoice || context.templateOutputDialect === "choice") {
    const controls = blockRsglCompletions.filter(candidate => blockstateControlLabels.has(candidate.label));
    return [...blockstateChoiceCompletions, ...controls, ...builtinRsglCompletions];
  }
  const blockstate = context.blockstate
    ?? (context.templateOutputDialect === "variants" || context.templateOutputDialect === "multipart"
      ? { mode: context.templateOutputDialect, scope: "entryTemplate" as const }
      : undefined);
  if (blockstate) {
    const controls = blockRsglCompletions.filter(candidate => blockstateControlLabels.has(candidate.label));
    const rootOperations = blockstate.scope === "entryTemplate"
      ? []
      : [
          ...blockRsglCompletions.filter(candidate =>
            blockstateRootOperationLabels.has(candidate.label)
            && (candidate.label !== "base" || context.allowBase)
          ),
          ...blockstateRootOnlyCompletions
        ];
    return [
      ...getBlockstateEntryCompletions(blockstate.mode),
      ...controls,
      ...rootOperations,
      ...builtinRsglCompletions
    ];
  }
  const blockCandidates = blockRsglCompletions.filter(candidate =>
    (candidate.label !== "base" || context.allowBase)
    && (candidate.label !== "extern var" || context.allowExternVar)
    && !itemOnlyBlockCompletionLabels.has(candidate.label)
    && completionMatchesTemplateDialect(candidate, context.templateOutputDialect)
  );
  return [...blockCandidates, ...builtinRsglCompletions];
}

function completionMatchesTemplateDialect(
  candidate: RsglCompletionCandidate,
  dialect: RsglCompletionContext["templateOutputDialect"]
): boolean {
  if (!dialect) {
    return true;
  }
  if (blockstateControlLabels.has(candidate.label)) {
    return true;
  }
  return !new Set([
    "range",
    "select",
    "condition",
    "composite",
    "special",
    "empty",
    "selected_item",
    "base"
  ]).has(candidate.label);
}
