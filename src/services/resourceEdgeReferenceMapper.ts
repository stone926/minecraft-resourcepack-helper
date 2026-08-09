import {
  minecraftReferenceKindForResourceKind,
  minecraftResourceTarget
} from "../../packages/mc-assets/src";
import type { ResourceEdge, ResourceProducer } from "../resourceUniverse/core/types";
import {
  isResourceReferenceKind,
  type ResourceReference
} from "../utils/resourceReferences/types";

/** Projects lossless edge evidence, or reconstructs the canonical reference shape. */
export function resourceReferenceForEdge(edge: ResourceEdge): ResourceReference | null {
  if (edge.sourceReference && isResourceReferenceKind(edge.sourceReference.kind)) {
    return {
      ...edge.sourceReference,
      kind: edge.sourceReference.kind,
      valueNode: {},
      relationship: edge.relationship === "modelParent" ? "modelParent" : undefined
    };
  }
  const kind = referenceKindForLogicalKind(edge.target.kind);
  if (!kind) {
    return null;
  }
  const target = minecraftResourceTarget(edge.target.kind);
  return {
    value: edge.target.id,
    valueNode: {},
    target: target.directory,
    source: "assets",
    extension: target.extension,
    kind,
    relationship: edge.relationship === "modelParent" ? "modelParent" : undefined
  };
}

/** Selects the serialized source URI without depending on VS Code or Universe state. */
export function resourceSourceUriForEdge(
  edge: ResourceEdge,
  sourceProducer?: ResourceProducer
): string | null {
  return edge.sourceLocation?.uri
    ?? sourceProducer?.sourceOrigins[0]?.uri
    ?? sourceProducer?.physicalOrigins[0]?.uri
    ?? null;
}

function referenceKindForLogicalKind(kind: string): ResourceReference["kind"] | null {
  const collapsed = minecraftReferenceKindForResourceKind(kind);
  return collapsed !== null && isResourceReferenceKind(collapsed) ? collapsed : null;
}
