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
    label: "model block",
    insertText: "model block ${1:id} {\n  parent minecraft:block/${2:cube_all}\n  textures {\n    all: minecraft:block/${1:id}\n  }\n}",
    detail: "Block model resource",
    kind: "snippet"
  },
  {
    label: "model item",
    insertText: "model item ${1:id} {\n  parent minecraft:item/generated\n  textures {\n    layer0: minecraft:item/${1:id}\n  }\n}",
    detail: "Item model resource",
    kind: "snippet"
  },
  {
    label: "blockstate",
    insertText: "blockstate ${1:id} {\n  variants {\n    {} -> { model: minecraft:block/${1:id} }\n  }\n}",
    detail: "Blockstate resource",
    kind: "snippet"
  },
  {
    label: "item",
    insertText: "item ${1:id} {\n  model minecraft:item/${1:id}\n}",
    detail: "26.x item model definition",
    kind: "snippet"
  },
  {
    label: "pack",
    insertText: "pack {\n  description \"${1:Generated pack}\"\n  pack_format ${2:88}\n}",
    detail: "pack.mcmeta resource",
    kind: "snippet"
  },
  {
    label: "lang",
    insertText: "lang ${1:en_us} {\n  \"${2:block.minecraft.stone}\" \"${3:Stone}\"\n}",
    detail: "Language resource",
    kind: "snippet"
  },
  {
    label: "sounds",
    insertText: "sounds ${1:minecraft} {\n  \"${2:block.example.break}\" { sounds: [\"${3:block/example_break}\"] }\n}",
    detail: "sounds.json resource",
    kind: "snippet"
  },
  {
    label: "mcmeta",
    insertText: "mcmeta \"${1:assets/minecraft/textures/block/example.png}\" {\n  animation { frametime ${2:5} }\n}",
    detail: "PNG metadata resource",
    kind: "snippet"
  },
  {
    label: "overlay",
    insertText: "overlay \"${1:future}\" format [${2:89}, ${3:0}]..[${4:90}, ${5:0}] {\n  ${6}\n}",
    detail: "Overlay output target",
    kind: "snippet"
  },
  {
    label: "cube_all",
    insertText: "cube_all [\n  ${1:stone}\n]",
    detail: "Batch cube_all model sugar",
    kind: "snippet"
  },
  {
    label: "items model",
    insertText: "items model [\n  ${1:diamond}\n]",
    detail: "Batch item mapping sugar",
    kind: "snippet"
  },
  {
    label: "stairs",
    insertText: "stairs ${1:acacia_stairs}",
    detail: "Conventional stairs blockstate sugar",
    kind: "snippet"
  },
  {
    label: "slab",
    insertText: "slab ${1:acacia_slab} double minecraft:block/${2:acacia_planks}",
    detail: "Conventional slab blockstate sugar",
    kind: "snippet"
  },
  {
    label: "fence",
    insertText: "fence ${1:oak_fence}",
    detail: "Conventional fence blockstate sugar",
    kind: "snippet"
  },
  {
    label: "wall",
    insertText: "wall ${1:cobblestone_wall}",
    detail: "Conventional wall blockstate sugar",
    kind: "snippet"
  },
  {
    label: "pane",
    insertText: "pane ${1:glass_pane}",
    detail: "Conventional pane blockstate sugar",
    kind: "snippet"
  },
  {
    label: "wood_family",
    insertText: "wood_family ${1:acacia} {\n  texture block/${1:acacia}_planks\n  generate [planks, slab, stairs, fence, fence_gate, door, trapdoor]\n}",
    detail: "Wood family sugar",
    kind: "snippet"
  }
];

export const blockRsglCompletions: RsglCompletionCandidate[] = [
  { label: "parent", insertText: "parent ${1:minecraft:block/cube_all}", detail: "Model parent", kind: "property" },
  { label: "textures", insertText: "textures {\n  ${1:all}: ${2:minecraft:block/stone}\n}", detail: "Model texture map", kind: "snippet" },
  { label: "variants", insertText: "variants {\n  ${1:{}} -> { model: ${2:minecraft:block/stone} }\n}", detail: "Blockstate variants section", kind: "snippet" },
  { label: "multipart", insertText: "multipart {\n  apply { model: ${1:minecraft:block/stone} }\n}", detail: "Blockstate multipart section", kind: "snippet" },
  { label: "use", insertText: "use ${1:templateName}(${2})", detail: "Template call", kind: "snippet" },
  { label: "for", insertText: "for ${1:item} in ${2:items} {\n  ${3}\n}", detail: "Finite expansion loop", kind: "snippet" },
  { label: "if", insertText: "if ${1:condition} {\n  ${2}\n}", detail: "Static conditional block", kind: "snippet" },
  { label: "when", insertText: "when { ${1:facing}: ${2:north} } apply { model: ${3:minecraft:block/stone} }", detail: "Multipart condition", kind: "snippet" },
  { label: "apply", insertText: "apply { model: ${1:minecraft:block/stone} }", detail: "Multipart model apply", kind: "snippet" },
  { label: "random", insertText: "random [\n  { model: ${1:minecraft:block/stone}, weight: ${2:1} }\n]", detail: "Random variant model list", kind: "snippet" },
  { label: "raw_json", insertText: "raw_json(\"${1:./resource.json}\")", detail: "JSON escape hatch", kind: "function" },
  { label: "@block", insertText: "@block/${1:model} ${2:y=90} ${3:uvlock}", detail: "Model apply sugar", kind: "snippet" }
];

export const builtinRsglCompletions: RsglCompletionCandidate[] = [
  { label: "cubeAll", detail: "Builtin block cube model template", kind: "function" },
  { label: "itemGenerated", detail: "Builtin generated item template", kind: "function" },
  { label: "itemRangeFrames", detail: "Builtin range_dispatch item helper", kind: "function" },
  { label: "itemSelectCases", detail: "Builtin select item helper", kind: "function" },
  { label: "atlasDirectory", detail: "Builtin atlas directory source helper", kind: "function" },
  { label: "particlesSeq", detail: "Builtin particle texture sequence helper", kind: "function" },
  { label: "mcmetaAnimation", detail: "Builtin PNG animation metadata helper", kind: "function" },
  { label: "equipmentLayers", detail: "Builtin equipment layer helper", kind: "function" },
  { label: "stairs", detail: "Builtin stairs blockstate template", kind: "function" },
  { label: "slab", detail: "Builtin slab blockstate template", kind: "function" },
  { label: "fence", detail: "Builtin fence blockstate template", kind: "function" },
  { label: "fenceGate", detail: "Builtin fence gate blockstate template", kind: "function" },
  { label: "door", detail: "Builtin door blockstate template", kind: "function" },
  { label: "trapdoor", detail: "Builtin trapdoor blockstate template", kind: "function" },
  { label: "wall", detail: "Builtin wall blockstate template", kind: "function" },
  { label: "pane", detail: "Builtin pane blockstate template", kind: "function" },
  { label: "randomVariants", detail: "Builtin random variants helper", kind: "function" },
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
