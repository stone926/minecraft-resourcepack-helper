export type ResourceDiagnosticCoverage = "authoritative" | "partial" | "unavailable";

export interface ResourceDiagnosticResolutionState {
  readonly resolved: boolean;
  readonly coverage: ResourceDiagnosticCoverage;
}

/** Missing-resource diagnostics are safe only when every applicable provider is authoritative. */
export function shouldReportMissingResource(
  resolution: ResourceDiagnosticResolutionState
): boolean {
  return !resolution.resolved && resolution.coverage === "authoritative";
}
