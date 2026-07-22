import {
  isResourceProjectUriWithin,
  type SerializedResourceUri
} from "../../../packages/resource-project/src";

/** Minimal URI surface used at the VS Code document boundary. */
export interface ResourceDocumentUri {
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  toString(): string;
}

/**
 * Tests an editor document against a canonical resource root without allowing
 * opaque, query-backed, or otherwise non-project virtual documents to escape
 * into the strict resource-project URI layer.
 */
export function isResourceDocumentUriWithin(
  uri: ResourceDocumentUri,
  rootUri: SerializedResourceUri
): boolean {
  if (!uri.path.startsWith("/") || uri.query.length > 0 || uri.fragment.length > 0) {
    return false;
  }
  try {
    return isResourceProjectUriWithin(uri.toString(), rootUri);
  } catch {
    return false;
  }
}
