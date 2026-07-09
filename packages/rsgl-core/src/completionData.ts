import { rsglResourceCompletionDescriptors } from "./resourceKinds";

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
    label: "template",
    insertText: "template ${1:name}(${2:id}: ${3:ResourceId}) {\n  ${4}\n}",
    detail: "Declarative template",
    kind: "snippet"
  },
  {
    label: "extern model",
    insertText: "extern model(id: ${1:minecraft:block/stone})",
    detail: "Declare an existing model without emitting it",
    kind: "snippet"
  },
  {
    label: "extern blockstate",
    insertText: "extern blockstate(id: ${1:minecraft:stone})",
    detail: "Declare an existing blockstate without emitting it",
    kind: "snippet"
  },
  {
    label: "extern item",
    insertText: "extern item(id: ${1:minecraft:diamond})",
    detail: "Declare an existing item definition without emitting it",
    kind: "snippet"
  },
  {
    label: "extern texture",
    insertText: "extern texture(id: ${1:minecraft:block/stone})",
    detail: "Declare an existing texture without emitting it",
    kind: "snippet"
  },
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
    insertText: "model block ${1:stone} impl cube_all(all: minecraft:block/${1:stone}) {\n  ${2}\n}",
    detail: "Declare a block model using a vanilla parent",
    kind: "snippet"
  },
  {
    label: "model item impl",
    insertText: "model item ${1:diamond} impl generated(layer0: minecraft:item/${1:diamond}) {\n  ${2}\n}",
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
    label: "import blockstate fragments",
    insertText: "import { ${1:stairs} } from \"rsgl:conventions/blockstate_fragments.rsgl\"",
    detail: "Import RSGL blockstate fragment templates",
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
  { label: "texture", insertText: "texture ${1:all} ${2:minecraft:block/stone}", detail: "Model texture variable", kind: "snippet" },
  { label: "textures", insertText: "textures {\n  ${1:all}: ${2:minecraft:block/stone}\n}", detail: "Model texture map", kind: "snippet" },
  { label: "box", insertText: "box \"${1:element}\" from [${2:0, 0, 0}] to [${3:16, 16, 16}] {\n  all texture \"#${4:all}\"\n}", detail: "Model element box", kind: "snippet" },
  { label: "element", insertText: "element from [${1:0, 0, 0}] to [${2:16, 16, 16}] {\n  all texture \"#${3:all}\"\n}", detail: "Model element geometry", kind: "snippet" },
  { label: "variants", insertText: "variants {\n  ${1:{}} -> { model: ${2:minecraft:block/stone} }\n}", detail: "Blockstate variants section", kind: "snippet" },
  { label: "multipart", insertText: "multipart {\n  apply { model: ${1:minecraft:block/stone} }\n}", detail: "Blockstate multipart section", kind: "snippet" },
  { label: "range", insertText: "range property ${1:minecraft:time} source ${2:daytime} wobble ${3:true} {\n  frames ${4:0..31} model ${5:minecraft:item/clock_00}\n  fallback ${6:minecraft:item/clock_00}\n}", detail: "Item range_dispatch model", kind: "snippet" },
  { label: "select", insertText: "select property ${1:minecraft:potion_contents} component ${2:minecraft:potion_contents} {\n  case ${3:\"minecraft:healing\"} -> ${4:minecraft:item/potion_healing}\n  fallback ${5:minecraft:item/potion}\n}", detail: "Item select model", kind: "snippet" },
  { label: "condition", insertText: "condition property ${1:minecraft:using_item} {\n  on_true ${2:minecraft:item/bow_pulling}\n  on_false ${3:minecraft:item/bow}\n}", detail: "Item condition model", kind: "snippet" },
  { label: "composite", insertText: "composite {\n  model ${1:minecraft:item/base}\n  model ${2:minecraft:item/overlay}\n}", detail: "Item composite model", kind: "snippet" },
  { label: "special", insertText: "special base ${1:minecraft:item/shield} model { type: ${2:minecraft:shield} }", detail: "Item special model", kind: "snippet" },
  { label: "empty", insertText: "empty", detail: "Item empty model", kind: "snippet" },
  { label: "selected_item", insertText: "selected_item", detail: "Bundle selected item model", kind: "snippet" },
  { label: "use", insertText: "use ${1:templateName}(${2})", detail: "Template call", kind: "snippet" },
  { label: "for", insertText: "for ${1:item} in ${2:items} {\n  ${3}\n}", detail: "Finite expansion loop", kind: "snippet" },
  { label: "for multidim", insertText: "for ${1:a} in ${2:items}, ${3:b} in ${4:variants} {\n  ${5}\n}", detail: "Multidimensional finite expansion loop", kind: "snippet" },
  { label: "if", insertText: "if ${1:condition} {\n  ${2}\n}", detail: "Static conditional block", kind: "snippet" },
  { label: "when", insertText: "when { ${1:facing}: ${2:north} } apply { model: ${3:minecraft:block/stone} }", detail: "Multipart condition", kind: "snippet" },
  { label: "apply", insertText: "apply { model: ${1:minecraft:block/stone} }", detail: "Multipart model apply", kind: "snippet" },
  { label: "random", insertText: "random [\n  { model: ${1:minecraft:block/stone}, weight: ${2:1} }\n]", detail: "Random variant model list", kind: "snippet" },
  { label: "raw_json", insertText: "raw_json {\n  ${1:key}: ${2:value}\n}", detail: "Inline JSON escape hatch", kind: "snippet" },
  { label: "raw_json_file", insertText: "raw_json_file(\"${1:./resource.json}\")", detail: "Load a JSON fragment from disk", kind: "function" },
  { label: "@block", insertText: "@block/${1:model} ${2:y=90} ${3:uvlock}", detail: "Model apply sugar", kind: "snippet" }
];

export const builtinRsglCompletions: RsglCompletionCandidate[] = [
  { label: "seq", insertText: "seq(${1:i} => \"minecraft:block/name_\" + ${1:i}, ${1:i}: ${2:0..3})", detail: "Compile-time string sequence", kind: "function" },
  { label: "atlasDirectory", detail: "Atlas directory source helper", kind: "function" },
  { label: "particlesSeq", insertText: "particlesSeq(\"${1:minecraft:particle/explosion_{0..2}}\", pad: ${2:0})", detail: "Particle texture sequence helper", kind: "function" },
  { label: "mcmetaAnimation", detail: "PNG animation metadata helper", kind: "function" },
  { label: "nineSliceGui", detail: "PNG GUI nine-slice metadata helper", kind: "function" },
  { label: "equipmentLayers", detail: "Equipment layer helper", kind: "function" },
  { label: "raw_json", insertText: "raw_json { ${1:key}: ${2:value} }", detail: "Inline JSON escape hatch", kind: "function" },
  { label: "raw_json_file", insertText: "raw_json_file(\"${1:./resource.json}\")", detail: "Load a JSON fragment from disk", kind: "function" },
  { label: "startsWith", insertText: "startsWith(${1:str}, ${2:prefix})", detail: "Compile-time string prefix predicate", kind: "function" },
  { label: "endsWith", insertText: "endsWith(${1:str}, ${2:suffix})", detail: "Compile-time string suffix predicate", kind: "function" },
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
  return isInsideBlock(text, offset)
    ? [...blockRsglCompletions, ...builtinRsglCompletions]
    : [...topLevelRsglCompletions, ...builtinRsglCompletions];
}

function isInsideBlock(text: string, offset: number): boolean {
  let depth = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString: "\"" | "`" | null = null;

  for (let index = 0; index < offset; index++) {
    const char = text[index];
    const next = text[index + 1] ?? "";

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index++;
      }
      continue;
    }

    if (inString) {
      if (char === "\\") {
        index++;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index++;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      index++;
    } else if (char === "\"" || char === "`") {
      inString = char;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth = Math.max(0, depth - 1);
    }
  }

  return depth > 0;
}
