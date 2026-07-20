import type { ResourceGraphLogicalKey } from "../../../packages/mc-assets/src";
import type {
  ProviderCoverage,
  ResourceCoverageScope,
  ResourceResolutionScope
} from "./types";

export type ProjectedProviderCoverage = "authoritative" | "notApplicable" | "unavailable";

export function projectProviderCoverage(
  coverage: ProviderCoverage | undefined,
  projectId: string,
  resolutionScope: ResourceResolutionScope,
  target: ResourceGraphLogicalKey
): ProjectedProviderCoverage {
  if (!coverage) {
    return "unavailable";
  }
  if (coverage.status === "notApplicable") {
    return "notApplicable";
  }
  if (coverage.status === "unavailable") {
    return "unavailable";
  }
  if (coverage.status === "authoritative") {
    return coverageScopeContains(coverage.coveredScope, projectId, resolutionScope, target)
      ? "authoritative"
      : "unavailable";
  }

  if (coverage.authoritativeScopes.some(scope =>
    coverageScopeContains(scope, projectId, resolutionScope, target)
  )) {
    return "authoritative";
  }
  return "unavailable";
}

export function coverageScopeContains(
  scope: ResourceCoverageScope,
  projectId: string,
  resolutionScope: ResourceResolutionScope,
  target: ResourceGraphLogicalKey
): boolean {
  if (scope.projectId !== projectId) {
    return false;
  }
  if (scope.resolutionScopes && !scope.resolutionScopes.includes(resolutionScope)) {
    return false;
  }
  if (scope.kinds && !scope.kinds.includes(target.kind)) {
    return false;
  }

  const separator = target.id.indexOf(":");
  const namespace = separator >= 0 ? target.id.slice(0, separator) : "minecraft";
  const resourcePath = separator >= 0 ? target.id.slice(separator + 1) : target.id;
  if (scope.namespaces && !scope.namespaces.includes(namespace)) {
    return false;
  }
  if (scope.pathPrefixes && !scope.pathPrefixes.some(prefix =>
    resourcePath === prefix || resourcePath.startsWith(`${prefix}/`)
  )) {
    return false;
  }
  return true;
}
