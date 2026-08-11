import type { ExternResourceSource, RsglExternDeclaration, RsglGlobalExternConfigEntry } from "../externDeclarations";
import type { ExternResourceKind } from "../resourceKinds";
import type { JsonValue, ResourceId, RsglCompileDiagnostic } from "./ir";

export interface RsglBlockstateSchema {
  properties: Record<string, readonly string[]>;
}

export type RsglResourceExistenceKind =
  | "model"
  | "blockstate"
  | "item"
  | "texture"
  | "textureDirectory"
  | "sound"
  | "font"
  | "fontFile"
  | "shaderVertex"
  | "shaderFragment";

export type RsglResourceContentKind = "model";

export interface RsglTextureMetadata {
  width: number;
  height: number;
}

export interface RsglSoundMetadata {
  codec?: string;
  channels?: number;
  sampleRate?: number;
  durationSeconds?: number;
}

export type ValidationRange = RsglCompileDiagnostic["range"];

/** Filesystem candidates considered while resolving one external resource. */
export interface RsglExternalResourceResolution {
  resolvedPath: string | null;
  candidatePaths: readonly string[];
  /** Winning physical layer when the resolution spans the effective pack stack. */
  source?: ExternResourceSource;
  /** pack.mcmeta inputs that determine overlays, filters, and pack priority. */
  metadataPaths?: readonly string[];
}

/** Exact source syntax that users can select for resource navigation. */
export interface RsglResourceNavigationSourceLocation {
  sourceFile: string;
  range: ValidationRange;
}

export interface RsglExternalResourceUsage {
  source: ExternResourceSource;
  /** Checked direct and inherited references use the effective Minecraft stack. */
  resolutionScope?: "effective" | ExternResourceSource;
  resourceKind: ExternResourceKind;
  targetKind: RsglResourceExistenceKind;
  id: string;
  skipExistenceCheck: boolean;
  sourceFile: string;
  range: ValidationRange;
  /** Separate from the dependency range when a value flowed through a parent/template. */
  navigationLocation?: RsglResourceNavigationSourceLocation;
  consumerOutputPath: string;
  consumerKind: string;
  consumerId?: string;
  consumer: string;
  sourceGeneratedPath?: string;
  origin: "direct" | "inherited";
  resolvedPath?: string;
  candidatePaths?: readonly string[];
  metadataPaths?: readonly string[];
}

/** Canonical source occurrence captured before generated/extern resolution. */
export interface RsglResourceReferenceUsage {
  targetKind: RsglResourceExistenceKind;
  /** Canonical physical lookup identity, including the namespace. */
  id: string;
  sourceFile: string;
  range: ValidationRange;
  /** Separate from the dependency range when a value flowed through a parent/template. */
  navigationLocation?: RsglResourceNavigationSourceLocation;
  /** Concrete final output that owns this reference edge. */
  consumerOutputPath: string;
  consumerKind: string;
  consumerId?: string;
  consumer: string;
  sourceGeneratedPath?: string;
  origin: "direct" | "inherited";
}

export interface RsglCheckedResourceReference {
  available: boolean;
  external: boolean;
  /** Canonical namespace:path written to a known Minecraft JSON sink. */
  canonicalId?: string;
  /** Canonical physical target used by generated/extern/disk resolution. */
  lookupId?: string;
  source?: ExternResourceSource;
  /** Winning physical definition retained for checked external references. */
  resolvedPath?: string;
  /** Ordered physical candidates retained even when no definition exists yet. */
  candidatePaths?: readonly string[];
  metadataPaths?: readonly string[];
}

export interface RsglResourceValidationOptions {
  targetPackFormat?: { major: number; minor?: number };
  /** Global declarations normally supplied by rsgl.config.json. */
  globalExterns?: readonly RsglGlobalExternConfigEntry[];
  /** Defaults to true. False has the same existence-check effect as extern!. */
  checkExternExistence?: boolean;
  /** Normalized local and global declarations assembled by the compile pipeline. */
  externDeclarations?: readonly RsglExternDeclaration[];
  resourceExists?: (kind: RsglResourceExistenceKind, id: string) => boolean;
  resourceContent?: (kind: RsglResourceContentKind, id: string) => JsonValue | null | undefined;
  textureMetadata?: (id: string) => RsglTextureMetadata | null | undefined;
  soundMetadata?: (id: string) => RsglSoundMetadata | null | undefined;
  blockstateSchema?: (id: ResourceId) => RsglBlockstateSchema | null | undefined;
  /** Effective local -> configured packs -> Default resource-stack resolution. */
  resourceResolution?: (
    kind: RsglResourceExistenceKind,
    id: string
  ) => RsglExternalResourceResolution;
  externResourceExists?: (source: ExternResourceSource, kind: RsglResourceExistenceKind, id: string) => boolean;
  /** Preferred resolver API; retains attempted paths when no candidate exists yet. */
  externResourceResolution?: (
    source: ExternResourceSource,
    kind: RsglResourceExistenceKind,
    id: string
  ) => RsglExternalResourceResolution;
  /** Compatibility resolver for hosts that only expose the winning path. */
  externResourcePath?: (source: ExternResourceSource, kind: RsglResourceExistenceKind, id: string) => string | null;
  externResourceContent?: (source: ExternResourceSource, kind: RsglResourceContentKind, id: string) => JsonValue | null | undefined;
  externTextureMetadata?: (source: ExternResourceSource, id: string) => RsglTextureMetadata | null | undefined;
  externSoundMetadata?: (source: ExternResourceSource, id: string) => RsglSoundMetadata | null | undefined;
  externBlockstateSchema?: (source: ExternResourceSource, id: ResourceId) => RsglBlockstateSchema | null | undefined;
  /** @internal Compile-time navigation collector; never performs resource I/O. */
  onResourceReferenceUsed?: (usage: RsglResourceReferenceUsage) => void;
  /** Internal compile-pipeline collector used to build concrete manifest dependencies. */
  onExternResourceUsed?: (usage: RsglExternalResourceUsage) => void;
  /** Internal generated-resource index used to exempt outputs from extern declarations. */
  generatedResourceIds?: ReadonlyMap<RsglResourceExistenceKind, ReadonlySet<string>>;
}
