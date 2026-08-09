import { workspaceResourceCache } from "../../../services/workspaceResourceCache";
import {
  findResourceReferenceAtPosition as findWithHost,
  getResourceReferences as getWithHost,
  type ResourceReference,
  type ResourceReferenceDocument,
  type ResourceReferencePosition
} from "../../../utils/resourceReferences";

export type { ResourceReference, ResourceReferenceDocument, ResourceReferencePosition };

export function getResourceReferences(
  document: ResourceReferenceDocument
): ResourceReference[] {
  return getWithHost(document, workspaceResourceCache);
}

export function findResourceReferenceAtPosition(
  document: ResourceReferenceDocument,
  position: ResourceReferencePosition
): ResourceReference | null {
  return findWithHost(document, position, workspaceResourceCache);
}
