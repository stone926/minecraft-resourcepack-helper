export const rsglMaterializationInvalidationProtocolVersion = 1;

/**
 * Wire-side watcher-invalidation DTO emitted after a materialization
 * transaction commits. The producer-side declaration lives in
 * rsgl-core's `materializationTypes.ts` (core must not depend on this
 * package); `test/contracts` asserts the two shapes stay assignable.
 */
export interface RsglMaterializationInvalidationDto {
  version: typeof rsglMaterializationInvalidationProtocolVersion;
  transactionId: string;
  projectId: string;
  ownershipRevision: string;
  state: "committed" | "partial";
  changedUris: readonly string[];
  deletedUris: readonly string[];
  manifestUri: string;
}

/**
 * Validates and normalizes (trims identities) an invalidation payload.
 * Returns undefined for any structural mismatch.
 */
export function parseRsglMaterializationInvalidation(
  value: unknown
): RsglMaterializationInvalidationDto | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== rsglMaterializationInvalidationProtocolVersion
    || (record.state !== "committed" && record.state !== "partial")
    || !isMaterializationSerializedUri(record.manifestUri)
    || !isSerializedUriArray(record.changedUris)
    || !isSerializedUriArray(record.deletedUris)
    || !isMaterializationIdentity(record.transactionId)
    || !isMaterializationIdentity(record.projectId)
    || !isMaterializationIdentity(record.ownershipRevision)) {
    return undefined;
  }
  return {
    version: rsglMaterializationInvalidationProtocolVersion,
    transactionId: record.transactionId.trim(),
    projectId: record.projectId.trim(),
    ownershipRevision: record.ownershipRevision.trim(),
    state: record.state,
    changedUris: record.changedUris as readonly string[],
    deletedUris: record.deletedUris as readonly string[],
    manifestUri: record.manifestUri
  };
}

function isSerializedUriArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isMaterializationSerializedUri);
}

function isMaterializationSerializedUri(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
    && !/^[a-zA-Z]:[\\/]/.test(value)
    && !value.includes("\0");
}

function isMaterializationIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}
