import type {
  ResourcePackProjectContextDto,
  ResourceProjectDiagnostic,
  ResourceProjectFileType,
  ResourceProjectSharedConfigurationDto,
  SerializedResourceUri
} from "../../packages/resource-project/src";

export interface ResourceProjectTextFile {
  text: string;
  revision: string;
}

/**
 * Narrow host boundary used by project discovery. The pure service never
 * assumes a local filesystem and therefore also works with remote URI schemes.
 */
export interface ResourcePackProjectServiceHost {
  stat(uri: SerializedResourceUri): Promise<ResourceProjectFileType | null>;
  readTextFile(uri: SerializedResourceUri): Promise<ResourceProjectTextFile | null>;
  getWorkspaceFolders(): readonly ResourceProjectWorkspaceFolder[];
}

export interface ResourceProjectWorkspaceFolder {
  uri: SerializedResourceUri;
  sharedConfiguration?: ResourceProjectSharedConfigurationDto;
  /** Stable fingerprint of the workspace-folder-scoped shared settings. */
  configurationRevision: string;
}

/** Main-host-only bounded probe result; intentionally absent from process DTOs. */
export type RsglProjectApplicability = "configured" | "conventional" | "none";

export type ResourcePackProjectServiceDiagnosticCode =
  | ResourceProjectDiagnostic["code"]
  | "resourceProject.invalidConfiguration"
  | "resourceProject.probeLimitExceeded";

export interface ResourcePackProjectServiceDiagnostic {
  code: ResourcePackProjectServiceDiagnosticCode;
  severity: "error" | "warning";
  message: string;
  relatedUris?: readonly SerializedResourceUri[];
}

export interface ResourcePackProjectServiceResult {
  context?: ResourcePackProjectContextDto;
  rsglApplicability: RsglProjectApplicability;
  diagnostics: readonly ResourcePackProjectServiceDiagnostic[];
  /** Exact config/metadata candidates whose changes invalidate this result. */
  dependencyUris: readonly SerializedResourceUri[];
}

export interface ResourcePackProjectDiscoveryOptions {
  /** Caps unique stat calls for one source; discovery never falls back to a glob. */
  maxStatProbes?: number;
}
