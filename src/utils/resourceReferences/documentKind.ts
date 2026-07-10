import { getResourceSurfaceDocumentKind } from "../../resources/resourceSurfaceRegistry";
import type { ResourceReferenceDocumentKind } from "./types";

export function getResourceReferenceDocumentKind(fileName: string): ResourceReferenceDocumentKind | null {
  return getResourceSurfaceDocumentKind(fileName);
}
