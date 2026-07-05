export const rsglGenericJsonResourceKinds = [
  "atlas",
  "particles",
  "equipment",
  "font",
  "waypoint_style",
  "post_effect"
] as const;

export type RsglGenericJsonResourceKind = typeof rsglGenericJsonResourceKinds[number];

export const rsglResourceKinds = [
  "model",
  "blockstate",
  "item",
  "atlas",
  "mcmeta",
  "particles",
  "equipment",
  "font",
  "waypoint_style",
  "post_effect",
  "pack",
  "lang",
  "sounds",
  "text"
] as const;

export type RsglResourceKind = typeof rsglResourceKinds[number];

export interface RsglResourceCompletionDescriptor {
  label: string;
  insertText: string;
  detail: string;
}

export const rsglResourceCompletionDescriptors: RsglResourceCompletionDescriptor[] = [
  {
    label: "model block",
    insertText: "model block ${1:id} {\n  parent minecraft:block/${2:cube_all}\n  textures {\n    all: minecraft:block/${1:id}\n  }\n}",
    detail: "Block model resource"
  },
  {
    label: "model item",
    insertText: "model item ${1:id} {\n  parent minecraft:item/generated\n  textures {\n    layer0: minecraft:item/${1:id}\n  }\n}",
    detail: "Item model resource"
  },
  {
    label: "blockstate",
    insertText: "blockstate ${1:id} {\n  variants {\n    {} -> { model: minecraft:block/${1:id} }\n  }\n}",
    detail: "Blockstate resource"
  },
  {
    label: "item",
    insertText: "item ${1:id} {\n  model minecraft:item/${1:id}\n}",
    detail: "26.x item model definition"
  },
  {
    label: "atlas",
    insertText: "atlas ${1:minecraft:blocks} {\n  sources [\n    { type: minecraft:directory, source: ${2:block}, prefix: \"${2:block}/\" }\n  ]\n}",
    detail: "Texture atlas resource"
  },
  {
    label: "particles",
    insertText: "particles ${1:example} {\n  textures [\n    ${2:minecraft:particle/example}\n  ]\n}",
    detail: "Particle texture list resource"
  },
  {
    label: "equipment",
    insertText: "equipment ${1:iron} {\n  layers {\n    ${2:humanoid}: [{ texture: ${3:minecraft:iron} }]\n  }\n}",
    detail: "Equipment layer resource"
  },
  {
    label: "font",
    insertText: "font ${1:default} {\n  providers [\n    { type: bitmap, file: ${2:minecraft:font/ascii.png}, ascent: ${3:7}, chars: [\"${4:abcdef}\"] }\n  ]\n}",
    detail: "Font provider resource"
  },
  {
    label: "waypoint_style",
    insertText: "waypoint_style ${1:default} {\n  near_distance ${2:128}\n  far_distance ${3:332}\n  sprites [\n    ${4:minecraft:default_0}\n  ]\n}",
    detail: "Waypoint locator bar style resource"
  },
  {
    label: "post_effect",
    insertText: "post_effect ${1:example} {\n  targets {\n    ${2:swap}: {}\n  }\n  passes [\n    { vertex_shader: ${3:minecraft:core/screenquad}, fragment_shader: ${4:minecraft:post/box_blur}, inputs: [{ sampler_name: \"In\", target: minecraft:main }], output: \"${2:swap}\" }\n  ]\n}",
    detail: "Post-processing effect resource"
  },
  {
    label: "pack",
    insertText: "pack {\n  description \"${1:Generated pack}\"\n  min_format [${2:88}, ${3:0}]\n  max_format [${2:88}, ${3:0}]\n}",
    detail: "pack.mcmeta resource"
  },
  {
    label: "lang",
    insertText: "lang ${1:en_us} {\n  \"${2:block.minecraft.stone}\" \"${3:Stone}\"\n}",
    detail: "Language resource"
  },
  {
    label: "sounds",
    insertText: "sounds ${1:minecraft} {\n  \"${2:block.example.break}\" { sounds: [\"${3:block/example_break}\"] }\n}",
    detail: "sounds.json resource"
  },
  {
    label: "text",
    insertText: "text ${1:minecraft:texts/end} {\n  content `${2:Generated text}`\n}",
    detail: "Text resource"
  },
  {
    label: "mcmeta",
    insertText: "mcmeta \"${1:assets/minecraft/textures/block/example.png}\" {\n  animation { frametime ${2:5} }\n}",
    detail: "PNG metadata resource"
  }
];

export function isRsglGenericJsonResourceKind(kind: string): kind is RsglGenericJsonResourceKind {
  return (rsglGenericJsonResourceKinds as readonly string[]).includes(kind);
}
