import type { ResourceGraphLogicalKey } from "../../../packages/mc-assets/src";
import {
  ResourceUniverseIndex,
  type ResourceLocation,
  type ResourceProducer,
  type ResourceResolutionContext,
  type ResourceResolutionResult
} from "../core";
import {
  resourceUriComparisonIdentity,
  sameResourceUri
} from "../core/resourceUriIdentity";

export interface ResourceNavigationOptions {
  activeUri?: string;
  preferMaterialized?: boolean;
}

export type ResourceNavigationResult =
  | {
      status: "resolved";
      target: ResourceGraphLogicalKey;
      primary: ResourceLocation;
      alternatives: readonly ResourceLocation[];
      producer: ResourceProducer;
      resolutionIncomplete: boolean;
    }
  | {
      status: "multiple";
      target: ResourceGraphLogicalKey;
      candidates: readonly ResourceProducer[];
      resolutionIncomplete: boolean;
    }
  | {
      status: "missing" | "incomplete";
      target: ResourceGraphLogicalKey;
      reason: "noProducer" | "providerUnavailable" | "noNavigableOrigin";
      candidates: readonly ResourceProducer[];
    }
  | {
      status: "conflict";
      target: ResourceGraphLogicalKey;
      candidates: readonly ResourceProducer[];
    };

export class ResourceNavigationService {
  public constructor(private readonly universe: ResourceUniverseIndex) {}

  public resolveDefinition(
    target: ResourceGraphLogicalKey,
    context: ResourceResolutionContext,
    options: ResourceNavigationOptions = {}
  ): ResourceNavigationResult {
    const resolution = this.universe.resolve(target, context);
    if (resolution.status === "missing") {
      return { status: "missing", target, reason: "noProducer", candidates: [] };
    }
    if (resolution.status === "conflict") {
      return {
        status: "conflict",
        target,
        candidates: resolution.candidates.map(candidate => candidate.producer)
      };
    }

    const candidateProducers = uniqueProducers(resolution.candidates.map(candidate => candidate.producer));
    if (candidateProducers.length === 0) {
      return {
        status: "incomplete",
        target,
        reason: "providerUnavailable",
        candidates: []
      };
    }
    const topPriority = resolution.candidates[0].layerPriority;
    const topProducers = uniqueProducers(resolution.candidates
      .filter(candidate => candidate.layerPriority === topPriority)
      .map(candidate => candidate.producer));
    if (topProducers.length > 1) {
      return {
        status: "multiple",
        target,
        candidates: topProducers,
        resolutionIncomplete: resolution.status === "incomplete"
      };
    }

    const producer = topProducers[0];
    return this.resolveProducerDefinition(
      target,
      producer,
      options,
      resolution.status === "incomplete"
    );
  }

  /** Applies the shared origin policy to a producer selected by a scoped compatibility resolver. */
  public resolveProducerDefinition(
    target: ResourceGraphLogicalKey,
    producer: ResourceProducer,
    options: ResourceNavigationOptions = {},
    resolutionIncomplete = false
  ): ResourceNavigationResult {
    const locations = orderedLocations(producer, options);
    if (locations.length === 0) {
      return {
        status: resolutionIncomplete ? "incomplete" : "missing",
        target,
        reason: "noNavigableOrigin",
        candidates: [producer]
      };
    }
    return {
      status: "resolved",
      target,
      primary: locations[0],
      alternatives: locations.slice(1),
      producer,
      resolutionIncomplete
    };
  }
}

function orderedLocations(
  producer: ResourceProducer,
  options: ResourceNavigationOptions
): ResourceLocation[] {
  const preferred = options.preferMaterialized
    ? [...producer.physicalOrigins, ...producer.sourceOrigins]
    : [...producer.sourceOrigins, ...producer.physicalOrigins];
  return uniqueLocations(preferred).sort((left, right) =>
    originPreferenceRank(left, options.preferMaterialized === true)
      - originPreferenceRank(right, options.preferMaterialized === true)
    || activeLocationRank(left, options.activeUri) - activeLocationRank(right, options.activeUri)
    || editableRank(left) - editableRank(right)
    || left.uri.localeCompare(right.uri, "en")
    || (left.range?.start ?? 0) - (right.range?.start ?? 0)
  );
}

function originPreferenceRank(location: ResourceLocation, preferMaterialized: boolean): number {
  const isMaterialized = location.origin === "materialized" || location.origin === "physical";
  return isMaterialized === preferMaterialized ? 0 : 1;
}

function activeLocationRank(location: ResourceLocation, activeUri: string | undefined): number {
  return activeUri && sameResourceUri(location.uri, activeUri) ? 0 : 1;
}

function editableRank(location: ResourceLocation): number {
  return location.editable === false ? 1 : 0;
}

function uniqueLocations(locations: readonly ResourceLocation[]): ResourceLocation[] {
  const unique = new Map<string, ResourceLocation>();
  for (const location of locations) {
    const identity = [
      resourceUriComparisonIdentity(location.uri),
      location.range?.start ?? "",
      location.range?.end ?? ""
    ].join("\0");
    if (!unique.has(identity)) {
      unique.set(identity, location);
    }
  }
  return [...unique.values()];
}

function uniqueProducers(producers: readonly ResourceProducer[]): ResourceProducer[] {
  return [...new Map(producers.map(producer => [producer.producerId, producer])).values()];
}

export function resolutionHasCertainMissing(result: ResourceResolutionResult): boolean {
  return result.status === "missing" && result.coverageComplete;
}
