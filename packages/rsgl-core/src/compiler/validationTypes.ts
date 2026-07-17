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
  /** pack.mcmeta inputs that determine overlays, filters, and pack priority. */
  metadataPaths?: readonly string[];
}

export interface RsglExternalResourceUsage {
  source: ExternResourceSource;
  resourceKind: ExternResourceKind;
  targetKind: RsglResourceExistenceKind;
  id: string;
  skipExistenceCheck: boolean;
  sourceFile: string;
  range: ValidationRange;
  resolvedPath?: string;
  candidatePaths?: readonly string[];
  metadataPaths?: readonly string[];
}

export interface RsglCheckedResourceReference {
  available: boolean;
  external: boolean;
  /** Canonical namespace:path written to a known Minecraft JSON sink. */
  canonicalId?: string;
  /** Canonical physical target used by generated/extern/disk resolution. */
  lookupId?: string;
  source?: ExternResourceSource;
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
  /** Internal compile-pipeline collector used to build concrete manifest dependencies. */
  onExternResourceUsed?: (usage: RsglExternalResourceUsage) => void;
  /** Internal generated-resource index used to exempt outputs from extern declarations. */
  generatedResourceIds?: ReadonlyMap<RsglResourceExistenceKind, ReadonlySet<string>>;
}
