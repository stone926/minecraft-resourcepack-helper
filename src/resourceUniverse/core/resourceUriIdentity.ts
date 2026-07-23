import {
  resourceProjectUriIdentity,
  type SerializedResourceUri
} from "../../../packages/resource-project/src";

/**
 * Returns a canonical comparison identity for hierarchical resource URIs.
 * Opaque compiler identities fall back to their exact serialized value.
 */
export function resourceUriComparisonIdentity(uri: string): string {
  try {
    return resourceProjectUriIdentity(uri as SerializedResourceUri);
  } catch {
    return uri;
  }
}

/** Compares transport-level URI serializations as resource identities. */
export function sameResourceUri(left: string, right: string): boolean {
  return left === right
    || resourceUriComparisonIdentity(left) === resourceUriComparisonIdentity(right);
}
