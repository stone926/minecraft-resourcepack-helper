import type { ResourceLayerSource } from "../../packages/resource-project/src";
import type { RsglProjectApplicability } from "../resourceProject";

export type LegacyReferenceEvidence = "localWinner" | "otherWinner" | "miss" | "unavailable";

export interface ReferenceIndexRefreshPolicyInput {
  documentScheme: string;
  rsglApplicability: RsglProjectApplicability | undefined;
  legacyEvidence: LegacyReferenceEvidence;
  layerSources: readonly ResourceLayerSource[];
}

/**
 * Decides whether one file-reference lookup needs the recursive Universe index.
 * Only an explicit non-RSGL project may use bounded legacy resolution as final
 * evidence; unknown applicability remains conservative.
 */
export function requiresReferenceIndexRefresh(
  input: ReferenceIndexRefreshPolicyInput
): boolean {
  if (input.documentScheme !== "file" || input.rsglApplicability !== "none") {
    return true;
  }
  if (input.legacyEvidence === "unavailable") {
    return true;
  }

  const hasArchiveLayer = input.layerSources.some(source => source !== "directory");
  if (!hasArchiveLayer) {
    return false;
  }

  // The local layer is always the highest-priority effective layer. A concrete
  // local winner therefore cannot be shadowed by a lower ZIP/JAR/index layer.
  return input.legacyEvidence !== "localWinner";
}
