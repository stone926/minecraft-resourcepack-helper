export type RsglResourceAstShape = "model" | "identified" | "anonymous";
export type RsglResourceBodyDialect = "model" | "blockstate" | "item" | "atlas" | "mcmeta" | "equipment" | "pack" | "generic";

export type RsglResourceCompileHandler =
  | "model"
  | "blockstate"
  | "item"
  | "genericJson"
  | "mcmeta"
  | "arbitraryJson"
  | "pack"
  | "lang"
  | "sounds"
  | "text"
  | "copy";

export type RsglResourceValidationHandler =
  | "model"
  | "blockstate"
  | "item"
  | "atlas"
  | "mcmeta"
  | "particles"
  | "equipment"
  | "font"
  | "waypointStyle"
  | "postEffect"
  | "pack"
  | "lang"
  | "sounds"
  | "none";

export type RsglResourceEmitContentKind = "json" | "text" | "binaryCopy";

export type RsglResourceEmitPathStrategy =
  | "resourceId"
  | "packRelativeOrResourceId"
  | "packMetadata"
  | "soundsNamespace"
  | "mcmetaTarget";

export interface RsglResourceCompletionDescriptor {
  label: string;
  insertText: string;
  detail: string;
}

interface RsglOrderedResourceCompletionDescriptor extends RsglResourceCompletionDescriptor {
  order: number;
}

export interface ResourceKindDescriptorDefinition {
  keyword: string;
  ast: {
    shape: RsglResourceAstShape;
    bodyDialect: RsglResourceBodyDialect;
    supportsImpl: boolean;
  };
  compile: {
    handler: RsglResourceCompileHandler;
    cardinality: "one" | "many";
  };
  validation: {
    handler: RsglResourceValidationHandler;
  };
  completions: readonly RsglOrderedResourceCompletionDescriptor[];
  emit: {
    contentKind: RsglResourceEmitContentKind;
    pathStrategy: RsglResourceEmitPathStrategy;
    jsonOrder: "model" | "item" | "default";
  };
}

export const rsglResourceKindDescriptors = [
  {
    keyword: "model",
    ast: { shape: "model", bodyDialect: "model", supportsImpl: true },
    compile: { handler: "model", cardinality: "one" },
    validation: { handler: "model" },
    completions: [
      {
        order: 10,
        label: "model block",
        insertText: "model block ${1:id} {\n  parent minecraft:block/${2:cube_all}\n  textures {\n    all: minecraft:block/${1:id}\n  }\n}",
        detail: "Block model resource"
      },
      {
        order: 11,
        label: "model item",
        insertText: "model item ${1:id} {\n  parent minecraft:item/generated\n  textures {\n    layer0: minecraft:item/${1:id}\n  }\n}",
        detail: "Item model resource"
      }
    ],
    emit: { contentKind: "json", pathStrategy: "resourceId", jsonOrder: "model" }
  },
  {
    keyword: "blockstate",
    ast: { shape: "identified", bodyDialect: "blockstate", supportsImpl: false },
    compile: { handler: "blockstate", cardinality: "one" },
    validation: { handler: "blockstate" },
    completions: [{
      order: 20,
      label: "blockstate",
      insertText: "blockstate ${1:id} {\n  variants {\n    {} -> { model: minecraft:block/${1:id} }\n  }\n}",
      detail: "Blockstate resource"
    }],
    emit: { contentKind: "json", pathStrategy: "resourceId", jsonOrder: "default" }
  },
  {
    keyword: "item",
    ast: { shape: "identified", bodyDialect: "item", supportsImpl: false },
    compile: { handler: "item", cardinality: "one" },
    validation: { handler: "item" },
    completions: [{
      order: 30,
      label: "item",
      insertText: "item ${1:id} {\n  model minecraft:item/${1:id}\n}",
      detail: "26.x item model definition"
    }],
    emit: { contentKind: "json", pathStrategy: "resourceId", jsonOrder: "item" }
  },
  {
    keyword: "atlas",
    ast: { shape: "identified", bodyDialect: "atlas", supportsImpl: false },
    compile: { handler: "genericJson", cardinality: "one" },
    validation: { handler: "atlas" },
    completions: [{
      order: 40,
      label: "atlas",
      insertText: "atlas ${1:minecraft:blocks} {\n  sources [\n    { type: minecraft:directory, source: ${2:block}, prefix: \"${2:block}/\" }\n  ]\n}",
      detail: "Texture atlas resource"
    }],
    emit: { contentKind: "json", pathStrategy: "resourceId", jsonOrder: "default" }
  },
  {
    keyword: "mcmeta",
    ast: { shape: "identified", bodyDialect: "mcmeta", supportsImpl: false },
    compile: { handler: "mcmeta", cardinality: "many" },
    validation: { handler: "mcmeta" },
    completions: [{
      order: 160,
      label: "mcmeta",
      insertText: "mcmeta \"${1:assets/minecraft/textures/block/example.png}\" {\n  animation { frametime ${2:5} }\n}",
      detail: "PNG metadata resource"
    }],
    emit: { contentKind: "json", pathStrategy: "mcmetaTarget", jsonOrder: "default" }
  },
  {
    keyword: "particles",
    ast: { shape: "identified", bodyDialect: "generic", supportsImpl: false },
    compile: { handler: "genericJson", cardinality: "one" },
    validation: { handler: "particles" },
    completions: [{
      order: 50,
      label: "particles",
      insertText: "particles ${1:example} {\n  textures [\n    ${2:minecraft:particle/example}\n  ]\n}",
      detail: "Particle texture list resource"
    }],
    emit: { contentKind: "json", pathStrategy: "resourceId", jsonOrder: "default" }
  },
  {
    keyword: "equipment",
    ast: { shape: "identified", bodyDialect: "equipment", supportsImpl: false },
    compile: { handler: "genericJson", cardinality: "one" },
    validation: { handler: "equipment" },
    completions: [{
      order: 60,
      label: "equipment",
      insertText: "equipment ${1:iron} {\n  layers {\n    ${2:humanoid}: [{ texture: ${3:minecraft:iron} }]\n  }\n}",
      detail: "Equipment layer resource"
    }],
    emit: { contentKind: "json", pathStrategy: "resourceId", jsonOrder: "default" }
  },
  {
    keyword: "font",
    ast: { shape: "identified", bodyDialect: "generic", supportsImpl: false },
    compile: { handler: "genericJson", cardinality: "one" },
    validation: { handler: "font" },
    completions: [{
      order: 70,
      label: "font",
      insertText: "font ${1:default} {\n  providers [\n    { type: bitmap, file: ${2:minecraft:font/ascii.png}, ascent: ${3:7}, chars: [\"${4:abcdef}\"] }\n  ]\n}",
      detail: "Font provider resource"
    }],
    emit: { contentKind: "json", pathStrategy: "resourceId", jsonOrder: "default" }
  },
  {
    keyword: "waypoint_style",
    ast: { shape: "identified", bodyDialect: "generic", supportsImpl: false },
    compile: { handler: "genericJson", cardinality: "one" },
    validation: { handler: "waypointStyle" },
    completions: [{
      order: 80,
      label: "waypoint_style",
      insertText: "waypoint_style ${1:default} {\n  near_distance ${2:128}\n  far_distance ${3:332}\n  sprites [\n    ${4:minecraft:default_0}\n  ]\n}",
      detail: "Waypoint locator bar style resource"
    }],
    emit: { contentKind: "json", pathStrategy: "resourceId", jsonOrder: "default" }
  },
  {
    keyword: "post_effect",
    ast: { shape: "identified", bodyDialect: "generic", supportsImpl: false },
    compile: { handler: "genericJson", cardinality: "one" },
    validation: { handler: "postEffect" },
    completions: [{
      order: 90,
      label: "post_effect",
      insertText: "post_effect ${1:example} {\n  targets {\n    ${2:swap}: {}\n  }\n  passes [\n    { vertex_shader: ${3:minecraft:core/screenquad}, fragment_shader: ${4:minecraft:post/box_blur}, inputs: [{ sampler_name: \"In\", target: minecraft:main }], output: \"${2:swap}\" }\n  ]\n}",
      detail: "Post-processing effect resource"
    }],
    emit: { contentKind: "json", pathStrategy: "resourceId", jsonOrder: "default" }
  },
  {
    keyword: "json",
    ast: { shape: "identified", bodyDialect: "generic", supportsImpl: false },
    compile: { handler: "arbitraryJson", cardinality: "one" },
    validation: { handler: "none" },
    completions: [{
      order: 100,
      label: "json",
      insertText: "json \"${1:assets/minecraft/custom/example.json}\" {\n  ${2:key}: ${3:value}\n}",
      detail: "Arbitrary pack-relative JSON resource"
    }],
    emit: { contentKind: "json", pathStrategy: "packRelativeOrResourceId", jsonOrder: "default" }
  },
  {
    keyword: "pack",
    ast: { shape: "anonymous", bodyDialect: "pack", supportsImpl: false },
    compile: { handler: "pack", cardinality: "one" },
    validation: { handler: "pack" },
    completions: [{
      order: 110,
      label: "pack",
      insertText: "pack {\n  description \"${1:Generated pack}\"\n  min_format [${2:88}, ${3:0}]\n  max_format [${2:88}, ${3:0}]\n}",
      detail: "pack.mcmeta resource"
    }],
    emit: { contentKind: "json", pathStrategy: "packMetadata", jsonOrder: "default" }
  },
  {
    keyword: "lang",
    ast: { shape: "identified", bodyDialect: "generic", supportsImpl: false },
    compile: { handler: "lang", cardinality: "one" },
    validation: { handler: "lang" },
    completions: [{
      order: 120,
      label: "lang",
      insertText: "lang ${1:en_us} {\n  \"${2:block.minecraft.stone}\" \"${3:Stone}\"\n}",
      detail: "Language resource"
    }],
    emit: { contentKind: "json", pathStrategy: "resourceId", jsonOrder: "default" }
  },
  {
    keyword: "sounds",
    ast: { shape: "identified", bodyDialect: "generic", supportsImpl: false },
    compile: { handler: "sounds", cardinality: "one" },
    validation: { handler: "sounds" },
    completions: [{
      order: 130,
      label: "sounds",
      insertText: "sounds ${1:minecraft} {\n  \"${2:block.example.break}\" { sounds: [\"${3:block/example_break}\"] }\n}",
      detail: "sounds.json resource"
    }],
    emit: { contentKind: "json", pathStrategy: "soundsNamespace", jsonOrder: "default" }
  },
  {
    keyword: "text",
    ast: { shape: "identified", bodyDialect: "generic", supportsImpl: false },
    compile: { handler: "text", cardinality: "one" },
    validation: { handler: "none" },
    completions: [{
      order: 140,
      label: "text",
      insertText: "text ${1:minecraft:texts/end} {\n  content `${2:Generated text}`\n}",
      detail: "Text resource"
    }],
    emit: { contentKind: "text", pathStrategy: "packRelativeOrResourceId", jsonOrder: "default" }
  },
  {
    keyword: "copy",
    ast: { shape: "identified", bodyDialect: "generic", supportsImpl: false },
    compile: { handler: "copy", cardinality: "one" },
    validation: { handler: "none" },
    completions: [{
      order: 150,
      label: "copy",
      insertText: "copy \"${1:pack.png}\" {\n  from \"${2:assets/pack.png}\"\n}",
      detail: "Binary copy resource"
    }],
    emit: { contentKind: "binaryCopy", pathStrategy: "packRelativeOrResourceId", jsonOrder: "default" }
  }
] as const satisfies readonly ResourceKindDescriptorDefinition[];

export type RsglResourceKind = typeof rsglResourceKindDescriptors[number]["keyword"];
export type ResourceKindDescriptor = typeof rsglResourceKindDescriptors[number];
export type RsglGenericJsonResourceKind = Extract<ResourceKindDescriptor, { compile: { handler: "genericJson" } }>["keyword"];

const descriptorByKeyword = new Map<string, ResourceKindDescriptor>(
  rsglResourceKindDescriptors.map(descriptor => [descriptor.keyword, descriptor])
);

export const rsglResourceKinds: readonly RsglResourceKind[] = rsglResourceKindDescriptors.map(descriptor => descriptor.keyword);

export const rsglGenericJsonResourceKinds: readonly RsglGenericJsonResourceKind[] = rsglResourceKindDescriptors
  .filter((descriptor): descriptor is Extract<ResourceKindDescriptor, { compile: { handler: "genericJson" } }> =>
    descriptor.compile.handler === "genericJson")
  .map(descriptor => descriptor.keyword);

export const rsglResourceCompletionDescriptors: RsglResourceCompletionDescriptor[] = rsglResourceKindDescriptors
  .flatMap((descriptor): readonly RsglOrderedResourceCompletionDescriptor[] => descriptor.completions)
  .sort((left, right) => left.order - right.order)
  .map(({ label, insertText, detail }) => ({ label, insertText, detail }));

export function getRsglResourceKindDescriptor(kind: string): ResourceKindDescriptor | undefined {
  return descriptorByKeyword.get(kind);
}

export function isRsglResourceKind(kind: string): kind is RsglResourceKind {
  return descriptorByKeyword.has(kind);
}

export function isRsglGenericJsonResourceKind(kind: string): kind is RsglGenericJsonResourceKind {
  return getRsglResourceKindDescriptor(kind)?.compile.handler === "genericJson";
}
