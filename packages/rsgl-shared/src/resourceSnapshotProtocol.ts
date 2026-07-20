import type { ResourcePackProjectContextDto } from "../../resource-project/src";

export const rsglResourceSnapshotProtocolVersion = 1;
export const rsglResourceSnapshotRequest = "rsgl/resourceSnapshot";
export const rsglResourceSnapshotInvalidatedNotification = "rsgl/resourceSnapshotInvalidated";

export type RsglResourceResolutionScope = "effective" | "local" | "custom" | "vanilla";

export type RsglResourceSnapshotScope =
  | { kind: "document"; documentUri: string }
  | { kind: "project"; projectId: string };

export interface RsglResourceSnapshotRequest {
  protocolVersion: typeof rsglResourceSnapshotProtocolVersion;
  projectContext: ResourcePackProjectContextDto;
  scope: RsglResourceSnapshotScope;
  knownRevision?: string;
  requestGeneration: number;
}

export interface RsglResourceLogicalKeyDto {
  kind: string;
  id: string;
}

export interface RsglResourceTextRangeDto {
  /** UTF-16 offset in the source document. */
  start: number;
  /** UTF-16 offset in the source document. */
  end: number;
}

export interface RsglResourceLocationDto {
  uri: string;
  range?: RsglResourceTextRangeDto;
  documentVersion?: number;
  documentSignature?: string;
}

export interface RsglResourceDto {
  producerId: string;
  kind: string;
  logicalKeys: readonly RsglResourceLogicalKeyDto[];
  aliasKeys?: readonly RsglResourceLogicalKeyDto[];
  aggregateMemberships?: readonly RsglResourceLogicalKeyDto[];
  outputPath: string;
  sourceOrigins: readonly RsglResourceLocationDto[];
  revision: string;
}

export interface RsglResourceEdgeDto {
  edgeId: string;
  sourceProducerId: string;
  target: RsglResourceLogicalKeyDto;
  resolutionScope: RsglResourceResolutionScope;
  resolutionContextId: string;
  sourceLocation: RsglResourceLocationDto;
  sourceGeneratedPath?: string;
  relationship?: string;
  origin: "direct" | "inherited";
  resolvedTarget?: RsglResolvedTargetDto;
}

export interface RsglResolvedTargetDto {
  status: "generated" | "physical" | "missing" | "unchecked";
  source?: "local" | "custom" | "vanilla";
  uri?: string;
  candidateUris?: readonly string[];
  metadataUris?: readonly string[];
  reason?: string;
}

export interface RsglResourceCoverageScopeDto {
  projectId: string;
  resolutionScopes?: readonly RsglResourceResolutionScope[];
  kinds?: readonly string[];
  namespaces?: readonly string[];
  pathPrefixes?: readonly string[];
}

export type RsglProviderCoverageDto =
  | { status: "notApplicable"; reason: "noRsglProject" | "outOfScope" }
  | {
      status: "authoritative";
      revision: string;
      coveredScope: RsglResourceCoverageScopeDto;
    }
  | {
      status: "partial";
      revision: string;
      authoritativeScopes: readonly RsglResourceCoverageScopeDto[];
      unavailableScopes: readonly RsglResourceCoverageScopeDto[];
      skippedSourceUris: readonly string[];
    }
  | {
      status: "unavailable";
      reason:
        | "notProbed"
        | "disabled"
        | "loading"
        | "runtimeLoadFailed"
        | "lspStarting"
        | "lspFailed"
        | "protocolMismatch"
        | "stale";
      lastKnownRevision?: string;
    };

export interface RsglResourceIssueDto {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  location?: RsglResourceLocationDto;
}

export interface RsglResourceSnapshotResponse {
  protocolVersion: typeof rsglResourceSnapshotProtocolVersion;
  projectId: string;
  requestGeneration: number;
  revision?: string;
  status: "ok" | "partial" | "notModified" | "unavailable";
  coverage: RsglProviderCoverageDto;
  resources?: readonly RsglResourceDto[];
  edges?: readonly RsglResourceEdgeDto[];
  skippedSourceUris?: readonly string[];
  issues?: readonly RsglResourceIssueDto[];
}

export interface RsglResourceSnapshotInvalidationNotification {
  protocolVersion: typeof rsglResourceSnapshotProtocolVersion;
  projectId: string;
  invalidationRevision: string;
  reason: "document" | "dependency" | "configuration" | "materialization" | "refresh";
  affectedSourceUris?: readonly string[];
}

export type RsglResourceSnapshotProtocolMessage =
  | RsglResourceSnapshotRequest
  | RsglResourceSnapshotResponse
  | RsglResourceSnapshotInvalidationNotification;

/** Rejects malformed or cross-version requests before they reach compiler state. */
export function isRsglResourceSnapshotRequest(value: unknown): value is RsglResourceSnapshotRequest {
  if (!isRecord(value)
    || value.protocolVersion !== rsglResourceSnapshotProtocolVersion
    || !isNonNegativeInteger(value.requestGeneration)
    || !isProjectContext(value.projectContext)
    || !isRecord(value.scope)
    || !optionalString(value.knownRevision)) {
    return false;
  }
  return value.scope.kind === "document"
    ? isSerializedUri(value.scope.documentUri)
    : value.scope.kind === "project"
      && isIdentity(value.scope.projectId)
      && value.scope.projectId === value.projectContext.projectId;
}

/**
 * Validates the contentless LSP response. `unavailable`/`notModified` payloads
 * cannot silently masquerade as authoritative empty snapshots.
 */
export function isRsglResourceSnapshotResponse(value: unknown): value is RsglResourceSnapshotResponse {
  if (!isRecord(value)
    || value.protocolVersion !== rsglResourceSnapshotProtocolVersion
    || !isIdentity(value.projectId)
    || !isNonNegativeInteger(value.requestGeneration)
    || !isSnapshotStatus(value.status)
    || !optionalString(value.revision)
    || !isCoverage(value.coverage)
    || !optionalArray(value.skippedSourceUris, isSerializedUri)
    || !optionalArray(value.resources, isResource)
    || !optionalArray(value.edges, isEdge)
    || !optionalArray(value.issues, isIssue)) {
    return false;
  }
  if (value.status === "ok") {
    return value.coverage.status === "authoritative"
      && Array.isArray(value.resources)
      && Array.isArray(value.edges)
      && value.revision === value.coverage.revision;
  }
  if (value.status === "partial") {
    return value.coverage.status === "partial"
      && Array.isArray(value.resources)
      && Array.isArray(value.edges)
      && value.revision === value.coverage.revision;
  }
  if (value.status === "notModified") {
    return value.coverage.status === "authoritative"
      && value.revision === value.coverage.revision
      && value.resources === undefined
      && value.edges === undefined;
  }
  return value.coverage.status === "unavailable"
    && value.resources === undefined
    && value.edges === undefined;
}

export function isRsglResourceSnapshotInvalidationNotification(
  value: unknown
): value is RsglResourceSnapshotInvalidationNotification {
  return isRecord(value)
    && value.protocolVersion === rsglResourceSnapshotProtocolVersion
    && isIdentity(value.projectId)
    && isIdentity(value.invalidationRevision)
    && isInvalidationReason(value.reason)
    && optionalArray(value.affectedSourceUris, isSerializedUri)
    && value.resources === undefined
    && value.edges === undefined;
}

function isProjectContext(value: unknown): value is ResourcePackProjectContextDto {
  if (!isRecord(value)
    || !isIdentity(value.projectId)
    || !isSerializedUri(value.workspaceFolderUri)
    || !isSerializedUri(value.projectRootUri)
    || !isSerializedUri(value.packRootUri)
    || !isSerializedUri(value.assetsRootUri)
    || !isSerializedUri(value.outputPackRootUri)
    || !isSerializedUri(value.outputAssetsRootUri)
    || !isIdentity(value.configurationRevision)
    || !isIdentity(value.contextRevision)
    || !Array.isArray(value.rsglSourceRootUris)
    || !value.rsglSourceRootUris.every(isSerializedUri)
    || !Array.isArray(value.externalLayers)
    || !value.externalLayers.every(isLayer)
    || !Array.isArray(value.overlaySelection)
    || !value.overlaySelection.every(isString)
    || !isLayer(value.localLayer)) {
    return false;
  }
  return value.vanillaLayer === undefined || isLayer(value.vanillaLayer);
}

function isLayer(value: unknown): value is ResourcePackProjectContextDto["localLayer"] {
  return isRecord(value)
    && isIdentity(value.layerId)
    && (value.role === "local" || value.role === "custom" || value.role === "vanilla")
    && (value.source === "directory" || value.source === "zip" || value.source === "clientJar" || value.source === "assetIndex")
    && isSerializedUri(value.rootUri)
    && Number.isSafeInteger(value.priority)
    && isIdentity(value.metadataRevision);
}

function isResource(value: unknown): value is RsglResourceDto {
  return isRecord(value)
    && value.content === undefined
    && isIdentity(value.producerId)
    && isIdentity(value.kind)
    && isPortableOutputPath(value.outputPath)
    && isIdentity(value.revision)
    && isArray(value.logicalKeys, isLogicalKey)
    && optionalArray(value.aliasKeys, isLogicalKey)
    && optionalArray(value.aggregateMemberships, isLogicalKey)
    && isArray(value.sourceOrigins, isLocation);
}

function isEdge(value: unknown): value is RsglResourceEdgeDto {
  return isRecord(value)
    && isIdentity(value.edgeId)
    && isIdentity(value.sourceProducerId)
    && isLogicalKey(value.target)
    && isResolutionScope(value.resolutionScope)
    && isIdentity(value.resolutionContextId)
    && isLocation(value.sourceLocation)
    && optionalString(value.sourceGeneratedPath)
    && optionalString(value.relationship)
    && (value.origin === "direct" || value.origin === "inherited")
    && (value.resolvedTarget === undefined || isResolvedTarget(value.resolvedTarget));
}

function isResolvedTarget(value: unknown): value is RsglResolvedTargetDto {
  if (!isRecord(value)
    || (value.status !== "generated" && value.status !== "physical" && value.status !== "missing" && value.status !== "unchecked")
    || (value.source !== undefined && value.source !== "local" && value.source !== "custom" && value.source !== "vanilla")
    || (value.uri !== undefined && !isSerializedUri(value.uri))
    || !optionalArray(value.candidateUris, isSerializedUri)
    || !optionalArray(value.metadataUris, isSerializedUri)
    || !optionalString(value.reason)) {
    return false;
  }
  return value.status !== "physical" || isSerializedUri(value.uri);
}

function isCoverage(value: unknown): value is RsglProviderCoverageDto {
  if (!isRecord(value)) {
    return false;
  }
  if (value.status === "notApplicable") {
    return value.reason === "noRsglProject" || value.reason === "outOfScope";
  }
  if (value.status === "authoritative") {
    return isIdentity(value.revision) && isCoverageScope(value.coveredScope);
  }
  if (value.status === "partial") {
    return isIdentity(value.revision)
      && isArray(value.authoritativeScopes, isCoverageScope)
      && isArray(value.unavailableScopes, isCoverageScope)
      && isArray(value.skippedSourceUris, isSerializedUri);
  }
  return value.status === "unavailable"
    && isUnavailableReason(value.reason)
    && optionalString(value.lastKnownRevision);
}

function isCoverageScope(value: unknown): value is RsglResourceCoverageScopeDto {
  return isRecord(value)
    && isIdentity(value.projectId)
    && optionalArray(value.resolutionScopes, isResolutionScope)
    && optionalArray(value.kinds, isIdentity)
    && optionalArray(value.namespaces, isIdentity)
    && optionalArray(value.pathPrefixes, isString);
}

function isIssue(value: unknown): value is RsglResourceIssueDto {
  return isRecord(value)
    && isIdentity(value.code)
    && (value.severity === "error" || value.severity === "warning" || value.severity === "info")
    && typeof value.message === "string"
    && (value.location === undefined || isLocation(value.location));
}

function isLocation(value: unknown): value is RsglResourceLocationDto {
  return isRecord(value)
    && isSerializedUri(value.uri)
    && (value.range === undefined || isRange(value.range))
    && (value.documentVersion === undefined || Number.isSafeInteger(value.documentVersion))
    && optionalString(value.documentSignature);
}

function isRange(value: unknown): value is RsglResourceTextRangeDto {
  return isRecord(value)
    && isNonNegativeInteger(value.start)
    && isNonNegativeInteger(value.end)
    && value.end >= value.start;
}

function isLogicalKey(value: unknown): value is RsglResourceLogicalKeyDto {
  return isRecord(value) && isIdentity(value.kind) && isIdentity(value.id);
}

function isPortableOutputPath(value: unknown): boolean {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && !value.includes("\\")
    && !value.startsWith("/")
    && !/^[a-zA-Z]:/.test(value)
    && !value.split("/").some(segment => segment === ".." || segment.length === 0);
}

function isSerializedUri(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && !/^[a-zA-Z]:[\\/]/.test(value)
    && /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

function isSnapshotStatus(value: unknown): boolean {
  return value === "ok" || value === "partial" || value === "notModified" || value === "unavailable";
}

function isResolutionScope(value: unknown): value is RsglResourceResolutionScope {
  return value === "effective" || value === "local" || value === "custom" || value === "vanilla";
}

function isUnavailableReason(value: unknown): boolean {
  return value === "notProbed"
    || value === "disabled"
    || value === "loading"
    || value === "runtimeLoadFailed"
    || value === "lspStarting"
    || value === "lspFailed"
    || value === "protocolMismatch"
    || value === "stale";
}

function isInvalidationReason(value: unknown): boolean {
  return value === "document"
    || value === "dependency"
    || value === "configuration"
    || value === "materialization"
    || value === "refresh";
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || isIdentity(value);
}

function isArray<T>(value: unknown, predicate: (item: unknown) => item is T): value is T[];
function isArray(value: unknown, predicate: (item: unknown) => boolean): value is unknown[];
function isArray(value: unknown, predicate: (item: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.every(predicate);
}

function optionalArray<T>(value: unknown, predicate: (item: unknown) => item is T): value is T[] | undefined;
function optionalArray(value: unknown, predicate: (item: unknown) => boolean): value is unknown[] | undefined;
function optionalArray(value: unknown, predicate: (item: unknown) => boolean): value is unknown[] | undefined {
  return value === undefined || isArray(value, predicate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
