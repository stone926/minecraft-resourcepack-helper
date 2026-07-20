export const rsglResourceNavigationProtocolVersion = 1;
/** Server-to-client request resolved by the main ResourceUniverse. */
export const rsglResourceNavigationRequest = "rsgl/resourceNavigation";

export type RsglResourceNavigationOperation = "definition" | "references";
export type RsglResourceNavigationScope = "effective" | "local" | "custom" | "vanilla";
export type RsglResourceNavigationDeclarationMode = "checked" | "unchecked" | "undeclared";

export interface RsglResourceNavigationLogicalTargetDto {
  kind: string;
  id: string;
}

/** URI-only source context. Native paths never cross the process boundary. */
export interface RsglResourceNavigationSourceContextDto {
  documentUri: string;
  sourceRootUri?: string;
  projectId?: string;
}

export interface RsglResourceNavigationRequest {
  protocolVersion: typeof rsglResourceNavigationProtocolVersion;
  requestGeneration: number;
  operation: RsglResourceNavigationOperation;
  sourceContext: RsglResourceNavigationSourceContextDto;
  target: RsglResourceNavigationLogicalTargetDto;
  resolutionScope: RsglResourceNavigationScope;
  declarationMode: RsglResourceNavigationDeclarationMode;
  includeDeclaration?: boolean;
}

export interface RsglResourceNavigationPositionDto {
  /** Zero-based UTF-16 line. */
  line: number;
  /** Zero-based UTF-16 code-unit offset within the line. */
  character: number;
}

export interface RsglResourceNavigationRangeDto {
  start: RsglResourceNavigationPositionDto;
  end: RsglResourceNavigationPositionDto;
}

export interface RsglResourceNavigationLocationDto {
  uri: string;
  /** Binary resources and files without a schema-aware definition omit this. */
  range?: RsglResourceNavigationRangeDto;
  origin: "physical" | "generated" | "materialized";
}

export type RsglResourceNavigationStatus =
  | "resolved"
  | "multiple"
  | "conflict"
  | "missing"
  | "incomplete"
  | "unchecked"
  | "unavailable"
  | "cancelled";

export type RsglResourceNavigationCoverage = "authoritative" | "partial" | "unavailable";

export type RsglResourceNavigationReason =
  | "noProject"
  | "noProducer"
  | "providerUnavailable"
  | "noNavigableOrigin"
  | "existenceCheckDisabled"
  | "resolutionIncomplete"
  | "conflict"
  | "cancelled"
  | "internalError";

export interface RsglResourceNavigationResponse {
  protocolVersion: typeof rsglResourceNavigationProtocolVersion;
  requestGeneration: number;
  operation: RsglResourceNavigationOperation;
  projectId?: string;
  status: RsglResourceNavigationStatus;
  coverage: RsglResourceNavigationCoverage;
  locations: readonly RsglResourceNavigationLocationDto[];
  reason?: RsglResourceNavigationReason;
}

/** Exact-version runtime guard for requests originating in the LSP process. */
export function isRsglResourceNavigationRequest(
  value: unknown
): value is RsglResourceNavigationRequest {
  if (!isRecord(value)
    || value.protocolVersion !== rsglResourceNavigationProtocolVersion
    || !isNonNegativeInteger(value.requestGeneration)
    || (value.operation !== "definition" && value.operation !== "references")
    || !isSourceContext(value.sourceContext)
    || !isLogicalTarget(value.target)
    || !isResolutionScope(value.resolutionScope)
    || !isDeclarationMode(value.declarationMode)
    || (value.includeDeclaration !== undefined && typeof value.includeDeclaration !== "boolean")) {
    return false;
  }
  return value.operation === "references" || value.includeDeclaration === undefined;
}

/** Exact-version runtime guard for responses before LSP locations are emitted. */
export function isRsglResourceNavigationResponse(
  value: unknown
): value is RsglResourceNavigationResponse {
  if (!isRecord(value)
    || value.protocolVersion !== rsglResourceNavigationProtocolVersion
    || !isNonNegativeInteger(value.requestGeneration)
    || (value.operation !== "definition" && value.operation !== "references")
    || (value.projectId !== undefined && !isIdentity(value.projectId))
    || !isStatus(value.status)
    || !isCoverage(value.coverage)
    || !Array.isArray(value.locations)
    || !value.locations.every(isLocation)
    || (value.reason !== undefined && !isReason(value.reason))) {
    return false;
  }
  if (value.status === "resolved" || value.status === "multiple") {
    return value.locations.length > 0;
  }
  if (value.status === "unchecked") {
    return value.locations.length === 0 && value.reason === "existenceCheckDisabled";
  }
  if (value.status === "cancelled") {
    return value.locations.length === 0 && value.reason === "cancelled";
  }
  if (value.status === "unavailable") {
    return value.locations.length === 0
      && (value.reason === "noProject" || value.reason === "providerUnavailable" || value.reason === "internalError");
  }
  return true;
}

function isSourceContext(value: unknown): value is RsglResourceNavigationSourceContextDto {
  return isRecord(value)
    && isSerializedUri(value.documentUri)
    && (value.sourceRootUri === undefined || isSerializedUri(value.sourceRootUri))
    && (value.projectId === undefined || isIdentity(value.projectId));
}

function isLogicalTarget(value: unknown): value is RsglResourceNavigationLogicalTargetDto {
  return isRecord(value) && isIdentity(value.kind) && isIdentity(value.id);
}

function isLocation(value: unknown): value is RsglResourceNavigationLocationDto {
  return isRecord(value)
    && isSerializedUri(value.uri)
    && (value.range === undefined || isRange(value.range))
    && (value.origin === "physical" || value.origin === "generated" || value.origin === "materialized");
}

function isRange(value: unknown): value is RsglResourceNavigationRangeDto {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end)
    && (value.end.line > value.start.line
      || (value.end.line === value.start.line && value.end.character >= value.start.character));
}

function isPosition(value: unknown): value is RsglResourceNavigationPositionDto {
  return isRecord(value)
    && isNonNegativeInteger(value.line)
    && isNonNegativeInteger(value.character);
}

function isResolutionScope(value: unknown): value is RsglResourceNavigationScope {
  return value === "effective" || value === "local" || value === "custom" || value === "vanilla";
}

function isDeclarationMode(value: unknown): value is RsglResourceNavigationDeclarationMode {
  return value === "checked" || value === "unchecked" || value === "undeclared";
}

function isStatus(value: unknown): value is RsglResourceNavigationStatus {
  return value === "resolved"
    || value === "multiple"
    || value === "conflict"
    || value === "missing"
    || value === "incomplete"
    || value === "unchecked"
    || value === "unavailable"
    || value === "cancelled";
}

function isCoverage(value: unknown): value is RsglResourceNavigationCoverage {
  return value === "authoritative" || value === "partial" || value === "unavailable";
}

function isReason(value: unknown): value is RsglResourceNavigationReason {
  return value === "noProject"
    || value === "noProducer"
    || value === "providerUnavailable"
    || value === "noNavigableOrigin"
    || value === "existenceCheckDisabled"
    || value === "resolutionIncomplete"
    || value === "conflict"
    || value === "cancelled"
    || value === "internalError";
}

function isSerializedUri(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && !/^[a-zA-Z]:[\\/]/.test(value)
    && /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
