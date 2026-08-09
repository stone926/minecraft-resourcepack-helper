import type { ResourcePackProjectContextDto } from "../../packages/resource-project/src";
import type {
  ProviderCoverage,
  ResourceResolutionContext,
  ResourceResolutionScope
} from "../resourceUniverse/core/types";
import { physicalProviderId } from "../resourceUniverse/core/providerIds";
import type { UnifiedResourceCoverage } from "./resourceUniverseNavigation";

export function createResourceResolutionContext(
  context: ResourcePackProjectContextDto,
  applicableProviderIds: readonly string[] = [physicalProviderId],
  scope: ResourceResolutionScope = "effective"
): ResourceResolutionContext {
  return {
    contextId: `${context.projectId}:${context.contextRevision}:${scope}`,
    projectId: context.projectId,
    scope,
    orderedLayerIds: orderedLayerIds(context, scope),
    applicableProviderIds
  };
}

export function visibleResourceCoverage(
  coverage: ProviderCoverage | undefined
): UnifiedResourceCoverage {
  if (!coverage || coverage.status === "unavailable") {
    return "unavailable";
  }
  return coverage.status === "partial" ? "partial" : "authoritative";
}

function orderedLayerIds(
  context: ResourcePackProjectContextDto,
  scope: ResourceResolutionScope
): string[] {
  if (scope === "local") {
    return [context.localLayer.layerId];
  }
  if (scope === "custom") {
    return context.externalLayers.map(layer => layer.layerId);
  }
  if (scope === "vanilla") {
    return context.vanillaLayer ? [context.vanillaLayer.layerId] : [];
  }
  return [
    context.localLayer.layerId,
    ...context.externalLayers.map(layer => layer.layerId),
    ...(context.vanillaLayer ? [context.vanillaLayer.layerId] : [])
  ];
}
