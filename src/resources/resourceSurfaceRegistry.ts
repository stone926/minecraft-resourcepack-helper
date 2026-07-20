import { uniqueValues } from "../../packages/mc-assets/src";
import { isCitModelFileName, isCitPropertiesFileName } from "../cit/citPaths";
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
  | { mode: "shader"; source: "shaders/core" | "shaders/post" }
  | { mode: "citProperties" };

export type ResourceGraphPreviewContext =
  | "modelResource"
  | "citPreviewResource"
  | "unsupportedPreviewResource";

export type ResourceSemanticDiagnosticsKind =
  | "packMetadata"
  | "model"
  | "postEffect"
  | "sounds";

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

const modelPreviewWhen =
  "resourceLangId == json && resourceExtname == .json && resourceDirname =~ /[\\\\/]assets[\\\\/][^\\\\/]+[\\\\/]models(?:[\\\\/]|$)/";
const citPreviewWhen =
  "resourceExtname == .properties && resourceDirname =~ /[\\\\/]assets[\\\\/][^\\\\/]+[\\\\/]citresewn(?:[\\\\/]|$)/";
const citGenerationWhen =
  "resourceExtname =~ /\\.(json|png)$/ && resourceDirname =~ /[\\\\/]assets[\\\\/][^\\\\/]+[\\\\/](?:items|models[\\\\/]item|textures[\\\\/]item)(?:[\\\\/]|$)/";

const referenceSurfaceRegistry = [
  jsonReferenceSurface(
    "blockstates",
    "blockstates",
    "**/blockstates/*.json",
    "%schema.blockstates.url%",
    getBlockstateReferences,
    ["model"],
    { graphPreviewContext: "unsupportedPreviewResource" }
  ),
  {
    id: "modelsBlock",
    documentKind: "modelsBlock",
    schema: [{ fileMatch: "**/models/**/*.json", url: "%schema.modelsBlock.url%" }],
    referenceExtraction: { mode: "json", extract: (ast: JsonDocumentNode) => getModelReferences(ast, "models/block") },
    referenceTargets: ["model", "texture"],
    graphFileExtensions: ["json"],
    fileNamePattern: /[\\/]models[\\/]block[\\/].+\.json$/i
  },
  {
    id: "modelsItem",
    documentKind: "modelsItem",
    schema: [{ fileMatch: "**/models/item/**/*.json", url: "%schema.modelsItem.url%" }],
    referenceExtraction: { mode: "json", extract: getItemModelReferences },
    referenceTargets: ["model", "texture"],
    manifestWhenClauses: [citGenerationWhen],
    fileNamePattern: /[\\/]models[\\/]item[\\/].+\.json$/i
  },
  {
    id: "models",
    documentKind: "models",
    language: "json",
    selectorPatterns: ["**/models/**/*.json"],
    capabilities: [...referenceCapabilities, "textureVariables"],
    referenceExtraction: { mode: "json", extract: (ast: JsonDocumentNode) => getModelReferences(ast, "models") },
    referenceTargets: ["model", "texture"],
    graphFileExtensions: ["json"],
    incomingReferenceRoots: [{ root: "models" }],
    manifestWhenClauses: [modelPreviewWhen],
    graphPreviewContext: "modelResource",
    semanticDiagnostics: "model",
    fileNamePattern: /[\\/]models[\\/].+\.json$/i
  },
  jsonReferenceSurface("particles", "particles", "**/particles/**/*.json", "%schema.particles.url%", getParticleReferences, ["texture"]),
  jsonReferenceSurface(
    "items",
    "items",
    "**/items/**/*.json",
    "%schema.items.url%",
    getItemDefinitionReferences,
    ["model", "texture"],
    {
      manifestWhenClauses: [citGenerationWhen],
      graphPreviewContext: "unsupportedPreviewResource"
    }
  ),
  jsonReferenceSurface("atlases", "atlases", "**/atlases/**/*.json", "%schema.atlases.url%", getAtlasReferences, ["texture", "textureDirectory"]),
  jsonReferenceSurface("equipment", "equipment", "**/equipment/**/*.json", "%schema.equipment.url%", getEquipmentReferences, ["texture"]),
  jsonReferenceSurface(
    "font",
    "font",
    "**/font/**/*.json",
    "%schema.font.url%",
    getFontReferences,
    ["font", "fontFile", "texture"],
    {
      watcherPatterns: ["**/assets/*/font/**/*"],
      incomingReferenceRoots: [{ root: "font" }]
    }
  ),
  jsonReferenceSurface("waypointStyle", "waypoint_style", "**/waypoint_style/**/*.json", "%schema.waypointStyle.url%", getWaypointStyleReferences, ["texture"]),
  jsonReferenceSurface(
    "postEffect",
    "post_effect",
    "**/post_effect/**/*.json",
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
    watcherPatterns: ["**/assets/*/sounds/**/*.ogg"],
    referenceExtraction: { mode: "json", extract: getSoundReferences },
    referenceTargets: ["sound"],
    graphFileExtensions: ["json"],
    incomingReferenceRoots: [{ root: "sounds" }],
    semanticDiagnostics: "sounds",
    fileNamePattern: /[\\/]assets[\\/][^\\/]+[\\/]sounds\.json$/i
  },
  shaderSurface("shaderCore", "core", "shaders/core"),
  shaderSurface("shaderPost", "post", "shaders/post"),
  {
    id: "citModel",
    documentKind: "citModel",
    language: "json",
    selectorPatterns: ["**/assets/*/citresewn/*.json", "**/assets/*/citresewn/**/*.json"],
    capabilities: [...referenceCapabilities, "citCodeAction"],
    referenceExtraction: { mode: "json", extract: getCitModelReferences },
    referenceTargets: ["model", "texture"],
    graphFileExtensions: ["json"],
    matchesFileName: isCitModelFileName
  },
  {
    id: "citProperties",
    documentKind: "citProperties",
    selectorPatterns: ["**/assets/*/citresewn/*.properties", "**/assets/*/citresewn/**/*.properties"],
    watcherPatterns: ["**/assets/*/citresewn/*.properties", "**/assets/*/citresewn/**/*.properties"],
    capabilities: [...referenceCapabilities, "citLanguage", "citCodeAction"],
    referenceExtraction: { mode: "citProperties" },
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
    id: "shaderInclude",
    watcherPatterns: ["**/assets/*/shaders/**/*.glsl"],
    capabilities: ["graph"],
    graphFileExtensions: ["glsl", "vsh", "fsh"],
    incomingReferenceRoots: [
      { root: "shaders" },
      { root: "shaders/core" },
      { root: "shaders/include" }
    ],
    fileNamePattern: /[\\/]assets[\\/][^\\/]+[\\/]shaders[\\/]include[\\/].+\.(?:glsl|vsh|fsh)$/i
  },
  {
    id: "assetJsonWatcher",
    watcherPatterns: ["**/assets/**/*.json"],
    incomingReferenceRoots: [{ root: "" }]
  },
  {
    id: "textureAssets",
    watcherPatterns: [
      "**/assets/*/textures/**/*.png",
      "**/assets/*/citresewn/*.png",
      "**/assets/*/citresewn/**/*.png"
    ],
    incomingReferenceRoots: [
      { root: "textures" },
      { root: "textures/particle" },
      { root: "textures/entity" },
      { root: "textures/entity/bed" },
      { root: "textures/entity/chest" },
      { root: "textures/entity/shulker" },
      { root: "textures/entity/signs" },
      { root: "textures/entity/signs/hanging" },
      { root: "textures/effect" },
      { root: "textures/gui/sprites/hud/locator_bar_dot" },
      { root: "textures/entity/equipment", stripLeadingSegments: 1 }
    ],
    manifestWhenClauses: [citGenerationWhen]
  },
  {
    id: "packMetadata",
    language: "json",
    watcherPatterns: ["**/pack.mcmeta", "**/pack.png", "**/assets/*/textures/**/*.png.mcmeta"],
    schema: [
      { fileMatch: "**/pack.mcmeta", url: "%schema.packMcmeta.url%" },
      { fileMatch: "**/textures/**/*.png.mcmeta", url: "%schema.pngMcmeta.url%" }
    ],
    semanticDiagnostics: "packMetadata",
    fileNamePattern: /[\\/]pack\.mcmeta$/i
  },
  schemaOnlySurface("lang", "**/assets/*/lang/*.json", "%schema.lang.url%"),
  schemaOnlySurface("credits", "**/assets/*/texts/credits.json", "%schema.credits.url%"),
  schemaOnlySurface("gpuWarnlist", "**/assets/*/gpu_warnlist.json", "%schema.gpuWarnlist.url%"),
  schemaOnlySurface("regionalCompliancies", "**/assets/*/regional_compliancies.json", "%schema.regionalCompliancies.url%"),
  schemaOnlySurface("rsglConfig", "**/rsgl.config.json", "%schema.rsglConfig.url%")
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
 * Broad, one-result discovery pattern used only for a folded directory
 * operation. Keep this structural boundary beside the resource descriptors so
 * registration modules do not grow a second resource-surface definition.
 */
export function getResourceStructureDiscoveryGlob(): string {
  return "{**/pack.mcmeta,**/assets/**}";
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
    fileNamePattern: new RegExp(`[\\\\/]${folder}[\\\\/].+\\.json$`, "i")
  };
}

function shaderSurface<const K extends "shaderCore" | "shaderPost">(
  documentKind: K,
  folder: "core" | "post",
  source: "shaders/core" | "shaders/post"
): ResourceSurfaceDescriptor<K> & { documentKind: K } {
  return {
    id: documentKind,
    documentKind,
    selectorPatterns: [
      `**/assets/*/shaders/${folder}/**/*.vsh`,
      `**/assets/*/shaders/${folder}/**/*.fsh`
    ],
    watcherPatterns: ["**/assets/*/shaders/**/*.vsh", "**/assets/*/shaders/**/*.fsh"],
    capabilities: referenceCapabilities,
    referenceExtraction: { mode: "shader", source },
    referenceTargets: ["shader"],
    graphFileExtensions: ["vsh", "fsh"],
    fileNamePattern: new RegExp(`[\\\\/]shaders[\\\\/]${folder}[\\\\/].+\\.(?:vsh|fsh)$`, "i")
  };
}

function schemaOnlySurface(id: string, fileMatch: string, url: string): ResourceSurfaceDescriptor {
  return { id, schema: [{ fileMatch, url }] };
}
