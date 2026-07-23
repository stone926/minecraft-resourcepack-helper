import { isResourceProjectUriWithin } from "../../packages/resource-project/src";
import type {
  ProviderCoverage,
  ResourceProviderUnavailableReason
} from "../resourceUniverse/core/types";
import { sameResourceUri } from "../resourceUniverse/core/resourceUriIdentity";

export type ResourceFactsCoverage = "authoritative" | "partial" | "unavailable";

export interface ProviderFactsCoverage {
  providerId: string;
  coverage: ResourceFactsCoverage;
  unavailableReason?: ResourceProviderUnavailableReason;
  skippedSourceUris?: readonly string[];
}

/** Restricts project-wide provider coverage to facts about one editor document. */
export function summarizeDocumentProviderFacts(
  providerId: string,
  coverage: ProviderCoverage | undefined,
  documentUri: string
): ProviderFactsCoverage {
  if (!coverage) {
    return { providerId, coverage: "unavailable" };
  }
  if (coverage.status === "unavailable") {
    return {
      providerId,
      coverage: "unavailable",
      unavailableReason: coverage.reason
    };
  }
  if (coverage.status !== "partial") {
    return { providerId, coverage: "authoritative" };
  }
  const skippedSourceUris = coverage.skippedSourceUris.filter(uri =>
    sameResourceUri(uri, documentUri)
  );
  return skippedSourceUris.length > 0
    ? { providerId, coverage: "partial", skippedSourceUris }
    : { providerId, coverage: "authoritative" };
}

/** Generated inventory is incomplete only when an RSGL source was skipped. */
export function summarizeGeneratedInventoryFacts(
  coverage: ProviderCoverage | undefined
): ResourceFactsCoverage {
  if (!coverage || coverage.status === "unavailable") {
    return "unavailable";
  }
  return coverage.status === "partial" && coverage.skippedSourceUris.length > 0
    ? "partial"
    : "authoritative";
}

/**
 * Physical inventory consumes only the local pack layer. Missing custom or
 * vanilla roots must not make local search and block inventory look partial.
 */
export function summarizeLocalPhysicalInventoryFacts(
  coverage: ProviderCoverage | undefined,
  localPackRootUri: string
): ResourceFactsCoverage {
  if (!coverage || coverage.status === "unavailable") {
    return "unavailable";
  }
  if (coverage.status !== "partial") {
    return "authoritative";
  }
  return coverage.skippedSourceUris.some(uri => isUriWithin(uri, localPackRootUri))
    ? "partial"
    : "authoritative";
}

export function combineResourceFactsCoverage(
  coverages: readonly ResourceFactsCoverage[]
): ResourceFactsCoverage {
  if (coverages.length === 0 || coverages.every(item => item === "authoritative")) {
    return "authoritative";
  }
  return coverages.every(item => item === "unavailable") ? "unavailable" : "partial";
}

function isUriWithin(candidateUri: string, rootUri: string): boolean {
  try {
    return isResourceProjectUriWithin(candidateUri, rootUri);
  } catch {
    return false;
  }
}
