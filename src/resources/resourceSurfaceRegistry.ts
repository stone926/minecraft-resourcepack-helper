import {
  minecraftResourceDirectory,
  uniqueValues
} from "../../packages/mc-assets/src";
import {
  citresewnSourceDirectory,
  getCitDocumentSource,
  isCitModelFileName,
  isCitPropertiesFileName
} from "./citResourceSurface";
import type { JsonDocumentNode } from "../utils/jsonAst";
import {
  getEquipmentReferences,
  getFontReferences,
  getParticleReferences,
  getPostEffectReferences,
  getSoundReferences,
  getWaypointStyleReferences
} from "../utils/resourceReferences/assetJsonRefs";
import { getAtlasReferences } from "../utils/resourceReferences/atlasRefs";
import {
  getBlockstateReferences,
  getCitModelReferences,
  getItemModelReferences,
  getModelReferences
} from "../utils/resourceReferences/blockstateModelRefs";
import { getItemDefinitionReferences } from "../utils/resourceReferences/itemDefinitionRefs";
import type {
  ResourceReference,
  ResourceReferenceKind
} from "../utils/resourceReferences/types";

export type ResourceSurfaceCapability =
  | "references"
  | "completion"
  | "diagnostics"
  | "graph"
  | "textureVariables"
  | "citLanguage"
  | "citCodeAction";

export interface ResourceDocumentSelector {
  language?: string;
  pattern: string;
}

export interface ResourceSchemaRegistration {
  fileMatch: string;
  url: string;
}

export interface ResourceIncomingReferenceRoot {
  /** Assets-relative directory prefix removed from candidate reference text. */
  root: string;
  /** Additional variable path segments removed after the root (for layered assets). */
  stripLeadingSegments?: number;
}

export type JsonReferenceExtractor = (
  ast: JsonDocumentNode,
  fileName: string
) => ResourceReference[];

export type ResourceReferenceExtraction =
  | { mode: "json"; extract: JsonReferenceExtractor }
  | { mode: "shader"; source: "shaders/core" | "shaders/post" | "shaders/include" }
  | { mode: "registered"; id: string };

export type ResourceGraphPreviewContext =
  | "modelResource"
  | "citPreviewResource"
  | "unsupportedPreviewResource";

export type ResourceSemanticDiagnosticsKind =
  | "atlas"
  | "packMetadata"
  | "model"
  | "postEffect"
  | "sounds"
  | "textureMetadata"
  | "waypointStyle";

export interface ResourceSurfaceDescriptor<K extends string = string> {
  id: string;
  documentKind?: K;
  language?: string;
  selectorPatterns?: readonly string[];
  watcherPatterns?: readonly string[];
  schema?: readonly ResourceSchemaRegistration[];
  capabilities?: readonly ResourceSurfaceCapability[];
  referenceExtraction?: ResourceReferenceExtraction;
  referenceTargets?: readonly ResourceReferenceKind[];
  graphFileExtensions?: readonly string[];
  incomingReferenceRoots?: readonly ResourceIncomingReferenceRoot[];
  graphPreviewContext?: ResourceGraphPreviewContext;
  /** Selects the structural semantic diagnostics handler for this surface. */
  semanticDiagnostics?: ResourceSemanticDiagnosticsKind;
  manifestWhenClauses?: readonly string[];
  fileNamePattern?: RegExp;
  matchesFileName?: (fileName: string) => boolean;
}

const referenceCapabilities: readonly ResourceSurfaceCapability[] = [
  "references",
  "completion",
  "diagnostics",
  "graph"
];

const blockstateDirectory = minecraftResourceDirectory("blockstate");
const modelDirectory = minecraftResourceDirectory("model");
const modelBlockDirectory = `${modelDirectory}/block` as const;
const modelItemDirectory = `${modelDirectory}/item` as const;
const particleDirectory = minecraftResourceDirectory("particles");
const itemDefinitionDirectory = minecraftResourceDirectory("item");
const atlasDirectory = minecraftResourceDirectory("atlas");
const equipmentDirectory = minecraftResourceDirectory("equipment");
const fontDirectory = minecraftResourceDirectory("font");
const waypointStyleDirectory = minecraftResourceDirectory("waypoint_style");
const postEffectDirectory = minecraftResourceDirectory("post_effect");
const soundDirectory = minecraftResourceDirectory("sound");
const shaderDirectory = minecraftResourceDirectory("shaderVertex");
const textureDirectory = minecraftResourceDirectory("texture");

/** Atlas IDs that the vanilla 26.2 client actually registers. */
export const builtinMinecraftAtlasNames = [
  "armor_trims",
  "banner_patterns",
  "blocks",
  "celestials",
  "chests",
  "decorated_pot",
  "gui",
  "items",
  "map_decorations",
  "paintings",
  "particles",
  "shield_patterns",
  "shulker_boxes"
] as const;

const modelPreviewWhen =
  `resourceLangId == json && resourceExtname == .json && resourceDirname =~ /[\\\\/]assets[\\\\/][^\\\\/]+[\\\\/]${modelDirectory}(?:[\\\\/]|$)/`;
const citPreviewWhen =
  `resourceExtname == .properties && resourceDirname =~ /[\\\\/]assets[\\\\/][^\\\\/]+[\\\\/]${citresewnSourceDirectory}(?:[\\\\/]|$)/`;
const citGenerationWhen =
  `resourceExtname =~ /\\.(json|png)$/ && resourceDirname =~ /[\\\\/]assets[\\\\/][^\\\\/]+[\\\\/](?:${itemDefinitionDirectory}|${manifestDirectoryPattern(modelItemDirectory)}|${manifestDirectoryPattern(`${textureDirectory}/item`)})(?:[\\\\/]|$)/`;

const referenceSurfaceRegistry = [
  jsonReferenceSurface(
    "blockstates",
    blockstateDirectory,
    `**/${blockstateDirectory}/*.json`,
    "%schema.blockstates.url%",
    getBlockstateReferences,
    ["model"],
    { graphPreviewContext: "unsupportedPreviewResource" }
  ),
  {
    id: "modelsBlock",
    documentKind: "modelsBlock",
    schema: [{ fileMatch: `**/${modelDirectory}/**/*.json`, url: "%schema.modelsBlock.url%" }],
    referenceExtraction: { mode: "json", extract: (ast: JsonDocumentNode) => getModelReferences(ast, modelBlockDirectory) },
    referenceTargets: ["model", "texture"],
    graphFileExtensions: ["json"],
    fileNamePattern: resourceJsonFilePattern(modelBlockDirectory)
  },
  {
    id: "modelsItem",
    documentKind: "modelsItem",
    schema: [{ fileMatch: `**/${modelItemDirectory}/**/*.json`, url: "%schema.modelsItem.url%" }],
    referenceExtraction: { mode: "json", extract: getItemModelReferences },
    referenceTargets: ["model", "texture"],
    manifestWhenClauses: [citGenerationWhen],
    fileNamePattern: resourceJsonFilePattern(modelItemDirectory)
  },
  {
    id: "models",
    documentKind: "models",
    language: "json",
    selectorPatterns: [`**/${modelDirectory}/**/*.json`],
    capabilities: [...referenceCapabilities, "textureVariables"],
    referenceExtraction: { mode: "json", extract: (ast: JsonDocumentNode) => getModelReferences(ast, modelDirectory) },
    referenceTargets: ["model", "texture"],
    graphFileExtensions: ["json"],
    incomingReferenceRoots: [{ root: modelDirectory }],
    manifestWhenClauses: [modelPreviewWhen],
    graphPreviewContext: "modelResource",
    semanticDiagnostics: "model",
    fileNamePattern: resourceJsonFilePattern(modelDirectory)
  },
  jsonReferenceSurface("particles", particleDirectory, `**/${particleDirectory}/**/*.json`, "%schema.particles.url%", getParticleReferences, ["texture"]),
  jsonReferenceSurface(
    "items",
    itemDefinitionDirectory,
    `**/${itemDefinitionDirectory}/**/*.json`,
    "%schema.items.url%",
    getItemDefinitionReferences,
    ["model", "texture"],
    {
      manifestWhenClauses: [citGenerationWhen],
      graphPreviewContext: "unsupportedPreviewResource"
    }
  ),
  jsonReferenceSurface(
    "atlases",
    atlasDirectory,
    `**/${atlasDirectory}/**/*.json`,
    "%schema.atlases.url%",
    getAtlasReferences,
    ["texture", "textureDirectory"],
    { semanticDiagnostics: "atlas" }
  ),
  jsonReferenceSurface("equipment", equipmentDirectory, `**/${equipmentDirectory}/**/*.json`, "%schema.equipment.url%", getEquipmentReferences, ["texture"]),
  jsonReferenceSurface(
    "font",
    fontDirectory,
    `**/${fontDirectory}/**/*.json`,
    "%schema.font.url%",
    getFontReferences,
    ["font", "fontFile", "texture"],
    {
      watcherPatterns: [`**/assets/*/${fontDirectory}/**/*`],
      incomingReferenceRoots: [{ root: fontDirectory }]
    }
  ),
  jsonReferenceSurface(
    "waypointStyle",
    waypointStyleDirectory,
    `**/${waypointStyleDirectory}/**/*.json`,
    "%schema.waypointStyle.url%",
    getWaypointStyleReferences,
    ["texture"],
    { semanticDiagnostics: "waypointStyle" }
  ),
  jsonReferenceSurface(
    "postEffect",
    postEffectDirectory,
    `**/${postEffectDirectory}/**/*.json`,
    "%schema.postEffect.url%",
    getPostEffectReferences,
    ["shader", "texture"],
    { semanticDiagnostics: "postEffect" }
  ),
  {
    id: "sounds",
    documentKind: "sounds",
    language: "json",
    selectorPatterns: ["**/assets/*/sounds.json"],
    schema: [{ fileMatch: "**/assets/*/sounds.json", url: "%schema.sounds.url%" }],
    capabilities: referenceCapabilities,
    watcherPatterns: [`**/assets/*/${soundDirectory}/**/*.ogg`],
    referenceExtraction: { mode: "json", extract: getSoundReferences },
    referenceTargets: ["sound"],
    graphFileExtensions: ["json"],
    incomingReferenceRoots: [{ root: soundDirectory }],
    semanticDiagnostics: "sounds",
    fileNamePattern: /[\\/]assets[\\/][^\\/]+[\\/]sounds\.json$/i
  },
  shaderSurface("shaderCore", "core", "shaders/core"),
  shaderSurface("shaderPost", "post", "shaders/post"),
  shaderIncludeSurface(),
  {
    id: "citModel",
    documentKind: "citModel",
    language: "json",
    selectorPatterns: [`**/assets/*/${citresewnSourceDirectory}/*.json`, `**/assets/*/${citresewnSourceDirectory}/**/*.json`],
    capabilities: [...referenceCapabilities, "citCodeAction"],
    referenceExtraction: {
      mode: "json",
      extract: (ast: JsonDocumentNode, fileName: string) =>
        getCitModelReferences(ast, getCitDocumentSource(fileName))
    },
    referenceTargets: ["model", "texture"],
    graphFileExtensions: ["json"],
    matchesFileName: isCitModelFileName
  },
  {
    id: "citProperties",
    documentKind: "citProperties",
    selectorPatterns: [`**/assets/*/${citresewnSourceDirectory}/*.properties`, `**/assets/*/${citresewnSourceDirectory}/**/*.properties`],
    watcherPatterns: [`**/assets/*/${citresewnSourceDirectory}/*.properties`, `**/assets/*/${citresewnSourceDirectory}/**/*.properties`],
    capabilities: [...referenceCapabilities, "citLanguage", "citCodeAction"],
    referenceExtraction: { mode: "registered", id: "citProperties" },
    referenceTargets: ["model", "texture"],
    graphFileExtensions: ["properties"],
    manifestWhenClauses: [citPreviewWhen],
    graphPreviewContext: "citPreviewResource",
    matchesFileName: isCitPropertiesFileName
  }
] as const;

export type ResourceReferenceDocumentKind = typeof referenceSurfaceRegistry[number]["documentKind"];

export const resourceSurfaceRegistry: readonly ResourceSurfaceDescriptor[] = [
  ...referenceSurfaceRegistry,
  {
    id: "assetJsonWatcher",
    watcherPatterns: ["**/assets/**/*.json"],
    incomingReferenceRoots: [{ root: "" }]
  },
  {
    id: "textureAssets",
    watcherPatterns: [
      `**/assets/*/${textureDirectory}/**/*.png`,
      `**/assets/*/${citresewnSourceDirectory}/*.png`,
      `**/assets/*/${citresewnSourceDirectory}/**/*.png`
    ],
    incomingReferenceRoots: [
      { root: textureDirectory },
      { root: `${textureDirectory}/particle` },
      { root: `${textureDirectory}/entity` },
      { root: `${textureDirectory}/entity/bed` },
      { root: `${textureDirectory}/entity/chest` },
      { root: `${textureDirectory}/entity/shulker` },
      { root: `${textureDirectory}/entity/signs` },
      { root: `${textureDirectory}/entity/signs/hanging` },
      { root: `${textureDirectory}/effect` },
      { root: `${textureDirectory}/gui/sprites/hud/locator_bar_dot` },
      { root: `${textureDirectory}/entity/equipment`, stripLeadingSegments: 1 }
    ],
    manifestWhenClauses: [citGenerationWhen]
  },
  {
    id: "packMetadata",
    language: "json",
    watcherPatterns: ["**/pack.mcmeta", "**/pack.png"],
    schema: [{ fileMatch: "**/pack.mcmeta", url: "%schema.packMcmeta.url%" }],
    semanticDiagnostics: "packMetadata",
    fileNamePattern: /[\\/]pack\.mcmeta$/i
  },
  {
    id: "textureMetadata",
    language: "json",
    watcherPatterns: [`**/assets/*/${textureDirectory}/**/*.png.mcmeta`],
    schema: [{ fileMatch: `**/${textureDirectory}/**/*.png.mcmeta`, url: "%schema.pngMcmeta.url%" }],
    semanticDiagnostics: "textureMetadata",
    fileNamePattern: /[\\/]assets[\\/][^\\/]+[\\/]textures[\\/].+\.png\.mcmeta$/i
  },
  schemaOnlySurface("lang", "**/assets/*/lang/*.json", "%schema.lang.url%"),
  schemaOnlySurface("credits", "**/assets/minecraft/texts/credits.json", "%schema.credits.url%"),
  schemaOnlySurface("gpuWarnlist", "**/assets/minecraft/gpu_warnlist.json", "%schema.gpuWarnlist.url%"),
  schemaOnlySurface(
    "regionalCompliancies",
    "**/assets/minecraft/regional_compliancies.json",
    "%schema.regionalCompliancies.url%"
  ),
  {
    ...schemaOnlySurface("rsglConfig", "**/rsgl.config.json", "%schema.rsglConfig.url%"),
    watcherPatterns: ["**/rsgl.config.json"]
  }
];

export function getResourceDocumentSelectors(
  capability: ResourceSurfaceCapability,
  registry: readonly ResourceSurfaceDescriptor[] = resourceSurfaceRegistry
): ResourceDocumentSelector[] {
  return registry
    .filter(surface => surface.capabilities?.includes(capability))
    .flatMap(surface => (surface.selectorPatterns ?? []).map(pattern => ({
      ...(surface.language ? { language: surface.language } : {}),
      pattern
    })));
}

export function getResourceWatcherPatterns(
  registry: readonly ResourceSurfaceDescriptor[] = resourceSurfaceRegistry
): string[] {
  return uniqueValues(registry.flatMap(surface => surface.watcherPatterns ?? []));
}

/**
 * Combine descriptor-owned patterns into the brace-union form accepted by
 * VS Code. This helper's inputs must be brace- and comma-free because it does
 * not parse or escape nested glob alternatives.
 */
export function getResourceWatcherGlob(
  registry: readonly ResourceSurfaceDescriptor[] = resourceSurfaceRegistry
): string | undefined {
  const patterns = getResourceWatcherPatterns(registry);
  if (patterns.length === 0) {
    return undefined;
  }
  const unsafePattern = patterns.find(pattern => /[{},]/.test(pattern));
  if (unsafePattern) {
    throw new Error(
      `Resource watcher union alternatives must be brace- and comma-free: ${unsafePattern}`
    );
  }
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

/**
 * Broad, one-result discovery pattern used only for a folded directory
 * operation. Keep this structural boundary beside the resource descriptors so
 * registration modules do not grow a second resource-surface definition.
 */
export function getResourceStructureDiscoveryGlob(): string {
  return "{**/pack.mcmeta,**/rsgl.config.json,**/assets/**}";
}

export function getResourceSchemaRegistrations(
  registry: readonly ResourceSurfaceDescriptor[] = resourceSurfaceRegistry
): ResourceSchemaRegistration[] {
  return registry.flatMap(surface => surface.schema ?? []);
}

export function getResourceManifestWhenClauses(
  registry: readonly ResourceSurfaceDescriptor[] = resourceSurfaceRegistry
): string[] {
  return uniqueValues(registry.flatMap(surface => surface.manifestWhenClauses ?? []));
}

export function getResourceGraphDiscoveryGlob(
  registry: readonly ResourceSurfaceDescriptor[] = resourceSurfaceRegistry
): string {
  const extensions = uniqueValues(registry
    .filter(surface => surface.capabilities?.includes("graph"))
    .flatMap(surface => surface.graphFileExtensions ?? []));
  if (extensions.length === 0) {
    return "**/assets/**";
  }
  return extensions.length === 1
    ? `**/assets/**/*.${extensions[0]}`
    : `**/assets/**/*.{${extensions.join(",")}}`;
}

export function getResourceIncomingReferenceRoots(
  registry: readonly ResourceSurfaceDescriptor[] = resourceSurfaceRegistry
): ResourceIncomingReferenceRoot[] {
  const roots = new Map<string, ResourceIncomingReferenceRoot>();
  for (const descriptor of registry) {
    for (const root of descriptor.incomingReferenceRoots ?? []) {
      const normalizedRoot = root.root.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
      const normalized = {
        root: normalizedRoot,
        ...(root.stripLeadingSegments ? { stripLeadingSegments: root.stripLeadingSegments } : {})
      };
      roots.set(`${normalized.root}\0${normalized.stripLeadingSegments ?? 0}`, normalized);
    }
  }
  return [...roots.values()];
}

export function getResourceGraphPreviewContext(
  fileName: string,
  registry: readonly ResourceSurfaceDescriptor[] = resourceSurfaceRegistry
): ResourceGraphPreviewContext | undefined {
  return registry.find(surface => surface.graphPreviewContext && matchesSurface(surface, fileName))?.graphPreviewContext;
}

export function getResourceGraphPreviewContexts(
  registry: readonly ResourceSurfaceDescriptor[] = resourceSurfaceRegistry
): ResourceGraphPreviewContext[] {
  return uniqueValues(registry.flatMap(surface => surface.graphPreviewContext ? [surface.graphPreviewContext] : []));
}

export function getResourceSurfaceDocumentKind(fileName: string): ResourceReferenceDocumentKind | null;
export function getResourceSurfaceDocumentKind<K extends string>(
  fileName: string,
  registry: readonly ResourceSurfaceDescriptor<K>[]
): K | null;
export function getResourceSurfaceDocumentKind<K extends string>(
  fileName: string,
  registry: readonly ResourceSurfaceDescriptor<K>[] = resourceSurfaceRegistry as readonly ResourceSurfaceDescriptor<K>[]
): K | null {
  return registry.find(surface => surface.documentKind && matchesSurface(surface, fileName))?.documentKind ?? null;
}

export function getResourceReferenceExtraction<K extends string>(
  documentKind: K,
  registry: readonly ResourceSurfaceDescriptor<K>[] = resourceSurfaceRegistry as readonly ResourceSurfaceDescriptor<K>[]
): ResourceReferenceExtraction | null {
  return registry.find(surface => surface.documentKind === documentKind)?.referenceExtraction ?? null;
}

export function getResourceReferenceTargets<K extends string>(
  documentKind: K,
  registry: readonly ResourceSurfaceDescriptor<K>[] = resourceSurfaceRegistry as readonly ResourceSurfaceDescriptor<K>[]
): readonly ResourceReferenceKind[] {
  return registry.find(surface => surface.documentKind === documentKind)?.referenceTargets ?? [];
}

export function filterResourceReferencesForSurface<K extends string>(
  documentKind: K,
  references: readonly ResourceReference[],
  registry: readonly ResourceSurfaceDescriptor<K>[] = resourceSurfaceRegistry as readonly ResourceSurfaceDescriptor<K>[]
): ResourceReference[] {
  const targets = new Set(getResourceReferenceTargets(documentKind, registry));
  return references.filter(reference => targets.has(reference.kind));
}

export function isResourceSurfaceFile(
  fileName: string,
  capability: ResourceSurfaceCapability,
  registry: readonly ResourceSurfaceDescriptor[] = resourceSurfaceRegistry
): boolean {
  return registry.some(surface => surface.capabilities?.includes(capability) && matchesSurface(surface, fileName));
}

export function getResourceSemanticDiagnosticsKind(
  fileName: string,
  languageId: string,
  registry: readonly ResourceSurfaceDescriptor[] = resourceSurfaceRegistry
): ResourceSemanticDiagnosticsKind | null {
  return registry.find(surface =>
    surface.semanticDiagnostics !== undefined &&
    surface.language === languageId &&
    matchesSurface(surface, fileName)
  )?.semanticDiagnostics ?? null;
}

function matchesSurface(surface: ResourceSurfaceDescriptor, fileName: string): boolean {
  return surface.fileNamePattern?.test(fileName) || surface.matchesFileName?.(fileName) === true;
}

function manifestDirectoryPattern(directory: string): string {
  return directory
    .split("/")
    .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]");
}

function resourceJsonFilePattern(directory: string): RegExp {
  return new RegExp(`[\\\\/]${manifestDirectoryPattern(directory)}[\\\\/].+\\.json$`, "i");
}

function jsonReferenceSurface<const K extends string>(
  documentKind: K,
  folder: string,
  selectorPattern: string,
  schemaUrl: string,
  extract: JsonReferenceExtractor,
  referenceTargets: readonly ResourceReferenceKind[],
  options: {
    watcherPatterns?: readonly string[];
    manifestWhenClauses?: readonly string[];
    graphPreviewContext?: ResourceGraphPreviewContext;
    semanticDiagnostics?: ResourceSemanticDiagnosticsKind;
    incomingReferenceRoots?: readonly ResourceIncomingReferenceRoot[];
  } = {}
): ResourceSurfaceDescriptor<K> & { documentKind: K } {
  return {
    id: documentKind,
    documentKind,
    language: "json",
    selectorPatterns: [selectorPattern],
    schema: [{ fileMatch: selectorPattern, url: schemaUrl }],
    capabilities: referenceCapabilities,
    watcherPatterns: options.watcherPatterns,
    referenceExtraction: { mode: "json", extract },
    referenceTargets,
    graphFileExtensions: ["json"],
    incomingReferenceRoots: options.incomingReferenceRoots,
    manifestWhenClauses: options.manifestWhenClauses,
    graphPreviewContext: options.graphPreviewContext,
    semanticDiagnostics: options.semanticDiagnostics,
    fileNamePattern: resourceJsonFilePattern(folder)
  };
}

function shaderSurface<const K extends "shaderCore" | "shaderPost">(
  documentKind: K,
  folder: "core" | "post",
  source: "shaders/core" | "shaders/post"
): ResourceSurfaceDescriptor<K> & { documentKind: K } {
  const namespace = documentKind === "shaderCore" ? "minecraft" : "*";
  return {
    id: documentKind,
    documentKind,
    selectorPatterns: [
      `**/assets/${namespace}/${shaderDirectory}/${folder}/**/*.vsh`,
      `**/assets/${namespace}/${shaderDirectory}/${folder}/**/*.fsh`
    ],
    watcherPatterns: [
      `**/assets/${namespace}/${shaderDirectory}/${folder}/**/*.vsh`,
      `**/assets/${namespace}/${shaderDirectory}/${folder}/**/*.fsh`
    ],
    capabilities: referenceCapabilities,
    referenceExtraction: { mode: "shader", source },
    referenceTargets: ["shader"],
    graphFileExtensions: ["vsh", "fsh"],
    fileNamePattern: new RegExp(
      `[\\\\/]assets[\\\\/]${namespace === "*" ? "[^\\\\/]+" : namespace}[\\\\/]${manifestDirectoryPattern(`${shaderDirectory}/${folder}`)}[\\\\/].+\\.(?:vsh|fsh)$`,
      "i"
    )
  };
}

function shaderIncludeSurface(): ResourceSurfaceDescriptor<"shaderInclude"> & {
  documentKind: "shaderInclude";
} {
  const patterns = ["glsl", "vsh", "fsh"].map(extension =>
    `**/assets/*/${shaderDirectory}/include/**/*.${extension}`
  );
  return {
    id: "shaderInclude",
    documentKind: "shaderInclude",
    selectorPatterns: patterns,
    watcherPatterns: patterns,
    capabilities: referenceCapabilities,
    referenceExtraction: { mode: "shader", source: "shaders/include" },
    referenceTargets: ["shader"],
    graphFileExtensions: ["glsl", "vsh", "fsh"],
    incomingReferenceRoots: [
      { root: shaderDirectory },
      { root: `${shaderDirectory}/core` },
      { root: `${shaderDirectory}/include` }
    ],
    fileNamePattern: new RegExp(
      `[\\\\/]assets[\\\\/][^\\\\/]+[\\\\/]${manifestDirectoryPattern(`${shaderDirectory}/include`)}[\\\\/].+\\.(?:glsl|vsh|fsh)$`,
      "i"
    )
  };
}

function schemaOnlySurface(id: string, fileMatch: string, url: string): ResourceSurfaceDescriptor {
  return { id, schema: [{ fileMatch, url }] };
}

const shaderSourceExtensions = new Set(
  (resourceSurfaceRegistry.find(surface => surface.id === "shaderInclude")?.graphFileExtensions ?? [])
    .map(extension => extension.toLowerCase())
);

/** Shader source-file test derived from the shaderInclude surface's extension list. */
export function isShaderSourceFileName(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 && shaderSourceExtensions.has(fileName.slice(dot + 1).toLowerCase());
}

/** Directories every workspace scan and anchor discovery skips. */
export const ignoredWorkspaceDirectoryNames: ReadonlySet<string> = new Set([".git", "node_modules", "out"]);

/** `findFiles` exclude glob derived from the ignored-directory set. */
export function getIgnoredWorkspaceGlob(): string {
  return `{${[...ignoredWorkspaceDirectoryNames].map(name => `**/${name}/**`).join(",")}}`;
}

const modelsSurfacePattern = resourceSurfaceRegistry
  .find(surface => surface.id === "models")?.fileNamePattern;

/** Model-JSON test shared with graph search; anchored variant is for previews. */
export function isModelJsonFileName(fileName: string): boolean {
  return modelsSurfacePattern?.test(fileName) ?? false;
}

const assetsModelJsonPattern = new RegExp(
  `[\\\\/]assets[\\\\/][^\\\\/]+[\\\\/]${modelDirectory}[\\\\/].+\\.json$`,
  "i"
);

export function isAssetsModelJsonFileName(fileName: string): boolean {
  return assetsModelJsonPattern.test(fileName);
}

const modelsItemPrefixPattern = new RegExp(
  `[\\\\/]${manifestDirectoryPattern(modelItemDirectory)}[\\\\/]`,
  "i"
);
const modelsBlockPrefixPattern = new RegExp(
  `[\\\\/]${manifestDirectoryPattern(modelBlockDirectory)}[\\\\/]`,
  "i"
);

/** Blockstate-model source directory owning a model file (mirrors modelsItem/modelsBlock surfaces). */
export function modelSourceForFileName(fileName: string): "models/item" | "models/block" | "models" {
  if (modelsItemPrefixPattern.test(fileName)) {
    return modelItemDirectory as "models/item";
  }
  if (modelsBlockPrefixPattern.test(fileName)) {
    return modelBlockDirectory as "models/block";
  }
  return modelDirectory as "models";
}

export type TextResourceFileKind = "splashes" | "endText" | "postcredits";

const textResourceKindsByBaseName: ReadonlyMap<string, TextResourceFileKind> = new Map([
  ["splashes.txt", "splashes"],
  ["end.txt", "endText"],
  ["postcredits.txt", "postcredits"]
]);

const textsDirectoryPattern = /[\\/]assets[\\/]minecraft[\\/]texts[\\/]([^\\/]+)$/i;

/** Kind of a fixed vanilla `assets/minecraft/texts/*.txt` document, or null. */
export function getTextResourceFileKind(fileName: string): TextResourceFileKind | null {
  const match = textsDirectoryPattern.exec(fileName);
  return match ? textResourceKindsByBaseName.get(match[1].toLowerCase()) ?? null : null;
}
