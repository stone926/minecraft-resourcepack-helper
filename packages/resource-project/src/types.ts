export type SerializedResourceUri = string;

export type ResourceLayerRole = "local" | "custom" | "vanilla";

export type ResourceLayerSource = "directory" | "zip" | "clientJar" | "assetIndex";

export interface ResourceLayerDescriptor {
  layerId: string;
  role: ResourceLayerRole;
  source: ResourceLayerSource;
  rootUri: SerializedResourceUri;
  priority: number;
  metadataRevision: string;
}

export interface ResourcePackFormatDto {
  major: number;
  minor?: number;
}

/**
 * Canonical, process-safe project topology. Every location is a serialized URI;
 * consumers may convert to a native path only at a filesystem-owning boundary.
 */
export interface ResourcePackProjectContextDto {
  projectId: string;
  workspaceFolderUri: SerializedResourceUri;
  projectRootUri: SerializedResourceUri;
  packRootUri: SerializedResourceUri;
  assetsRootUri: SerializedResourceUri;
  rsglSourceRootUris: readonly SerializedResourceUri[];
  outputPackRootUri: SerializedResourceUri;
  outputAssetsRootUri: SerializedResourceUri;
  targetPackFormat?: ResourcePackFormatDto;
  localLayer: ResourceLayerDescriptor;
  vanillaLayer?: ResourceLayerDescriptor;
  externalLayers: readonly ResourceLayerDescriptor[];
  overlaySelection: readonly string[];
  configurationRevision: string;
  contextRevision: string;
}

export type ResourcePackProjectContext = ResourcePackProjectContextDto;

export interface ResourceLayerConfigurationDto {
  role: ResourceLayerRole;
  source: ResourceLayerSource;
  /** Absolute serialized URI or a path relative to the owning configuration. */
  root: string;
  priority?: number;
  layerId?: string;
  metadataRevision?: string;
}

export interface ResourceProjectConfigurationDto {
  /** URI of rsgl.config.json (or an equivalent authoritative project file). */
  configUri: SerializedResourceUri;
  root?: string;
  outDir?: string;
  targetPackFormat?: ResourcePackFormatDto;
  /** Null is an explicit project-level override that disables the shared layer. */
  vanillaLayer?: ResourceLayerConfigurationDto | null;
  externalLayers?: readonly ResourceLayerConfigurationDto[];
  overlaySelection?: readonly string[];
}

export interface ResourceProjectSharedConfigurationDto {
  vanillaLayer?: ResourceLayerConfigurationDto | null;
  externalLayers?: readonly ResourceLayerConfigurationDto[];
  overlaySelection?: readonly string[];
}

export interface ResourceProjectResolutionRequest {
  sourceUri: SerializedResourceUri;
  workspaceFolderUris: readonly SerializedResourceUri[];
  configuration?: ResourceProjectConfigurationDto;
  sharedConfiguration?: ResourceProjectSharedConfigurationDto;
}

export type ResourceProjectFileType = "file" | "directory";

/** Minimal async topology boundary; implementations need not expose native paths. */
export interface ResourceProjectTopologyHost {
  stat(uri: SerializedResourceUri): Promise<ResourceProjectFileType | null>;
}

export type ResourceProjectDiagnosticCode =
  | "resourceProject.invalidUri"
  | "resourceProject.packRootNotFound"
  | "resourceProject.ambiguousPackRoot"
  | "resourceProject.outputMustBePackRoot"
  | "resourceProject.sourceOutsideConfiguredRoot"
  | "resourceProject.invalidLayer";

export interface ResourceProjectDiagnostic {
  code: ResourceProjectDiagnosticCode;
  severity: "error" | "warning";
  message: string;
  relatedUris?: readonly SerializedResourceUri[];
}

export interface ResourceProjectResolutionResult {
  context?: ResourcePackProjectContextDto;
  diagnostics: readonly ResourceProjectDiagnostic[];
}
