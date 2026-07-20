import type { ProviderCoverage } from "../resourceUniverse";

/** Prevents Tree refresh -> notModified replacement -> Tree refresh loops. */
export function shouldRequestGeneratedSnapshot(
  coverage: ProviderCoverage | undefined
): boolean {
  return coverage === undefined
    || (coverage.status === "unavailable"
      && (coverage.reason === "notProbed" || coverage.reason === "stale"));
}
