import * as vscode from "vscode";
import {
  isResourceProjectUriWithin,
  type ResourceLayerSource,
  type ResourcePackProjectContextDto
} from "../../packages/resource-project/src";
import type { ResourceGraphLogicalKey } from "../../packages/mc-assets/src";
import type { RsglProjectApplicability } from "../resourceProject";
import { physicalProviderId } from "../resourceUniverse/core/providerIds";
import { resourceUriComparisonIdentity } from "../resourceUniverse/core/resourceUriIdentity";
import type { ResourceProducer } from "../resourceUniverse/core/types";
import type { ResourceUniverseService } from "../resourceUniverse/core/resourceUniverseService";
import type { ResourceNavigationService } from "../resourceUniverse/navigation/resourceNavigationService";
import {
  generateReferenceRedirectPath,
  type ResourceReferencePathResolver
} from "../utils/pathGenerator";
import type { ResourceReference } from "../utils/resourceReferences";
import {
  requiresReferenceIndexRefresh,
  type LegacyReferenceEvidence
} from "./referenceIndexRefreshPolicy";
import { createResourceResolutionContext } from "./resourceNavigationContext";
import type {
  EnsuredResourceProject,
  ResourceUniverseDocument,
  UnifiedReferenceResolution,
  UnifiedResourceQueryOptions
} from "./resourceUniverseNavigation";

export interface LegacyReferenceResolution {
  readonly winner: vscode.Uri | null;
  readonly reliable: boolean;
}

/**
 * Compatibility boundary for filesystem resolution during the visible
 * ResourceUniverse migration. It owns legacy evidence and physical-winner
 * reconciliation; callers remain unaware of URI identity details.
 */
export class LegacyReferenceBridge {
  public constructor(
    private readonly universe: ResourceUniverseService,
    private readonly navigation: ResourceNavigationService,
    private readonly legacyResolver: ResourceReferencePathResolver = generateReferenceRedirectPath
  ) {}

  public resolve(
    document: ResourceUniverseDocument,
    reference: ResourceReference
  ): LegacyReferenceResolution {
    if (document.uri.scheme !== "file") {
      return { winner: null, reliable: false };
    }
    try {
      return { winner: this.legacyResolver(reference, document), reliable: true };
    } catch {
      return { winner: null, reliable: false };
    }
  }

  public requiresIndexRefresh(
    document: ResourceUniverseDocument,
    context: ResourcePackProjectContextDto,
    rsglApplicability: RsglProjectApplicability | undefined,
    resolution: LegacyReferenceResolution
  ): boolean {
    return requiresReferenceIndexRefresh({
      documentScheme: document.uri.scheme,
      rsglApplicability,
      legacyEvidence: legacyReferenceEvidence(context, resolution),
      layerSources: projectLayerSources(context)
    });
  }

  public resolveIndexedReference(
    document: ResourceUniverseDocument,
    target: ResourceGraphLogicalKey | undefined,
    legacyWinner: vscode.Uri | null,
    ensured: EnsuredResourceProject,
    options: UnifiedResourceQueryOptions,
    applicableProviderIds: readonly string[]
  ): UnifiedReferenceResolution {
    if (!target || !ensured.context) {
      return {
        target,
        targetUri: legacyWinner,
        coverage: ensured.context
          ? ensured.coverage
          : legacyWinner
            ? "authoritative"
            : "unavailable"
      };
    }

    // The legacy resolver owns directory-layer overlay/filter/load-order and
    // CIT policy. Reconcile its concrete winner with the physical producer;
    // archive layers fall through to ordered virtual origins.
    if (!options.includeGenerated && document.uri.scheme === "file" && legacyWinner) {
      const producer = this.findPhysicalProducer(
        target,
        ensured.context.projectId,
        legacyWinner
      );
      if (!producer) {
        return { target, targetUri: legacyWinner, coverage: "partial" };
      }
      const navigation = this.navigation.resolveProducerDefinition(
        target,
        producer,
        { activeUri: document.uri.toString() },
        ensured.coverage !== "authoritative"
      );
      return {
        target,
        targetUri: navigation.status === "resolved"
          ? vscode.Uri.parse(navigation.primary.uri, true)
          : legacyWinner,
        coverage: ensured.coverage,
        navigation
      };
    }

    const navigation = this.navigation.resolveDefinition(
      target,
      createResourceResolutionContext(ensured.context, applicableProviderIds),
      { activeUri: document.uri.toString() }
    );
    return {
      target,
      targetUri: navigation.status === "resolved"
        ? vscode.Uri.parse(navigation.primary.uri, true)
        : null,
      coverage: ensured.coverage,
      navigation
    };
  }

  private findPhysicalProducer(
    target: ResourceGraphLogicalKey,
    projectId: string,
    winner: vscode.Uri
  ): ResourceProducer | undefined {
    const winnerIdentity = resourceUriComparisonIdentity(winner.toString());
    return this.universe.getProducersForKey(target).find(producer =>
      producer.projectId === projectId
      && producer.providerId === physicalProviderId
      && producer.physicalOrigins.some(origin =>
        resourceUriComparisonIdentity(origin.uri) === winnerIdentity)
    );
  }
}

function projectLayerSources(context: ResourcePackProjectContextDto): ResourceLayerSource[] {
  return [
    context.localLayer.source,
    ...context.externalLayers.map(layer => layer.source),
    ...(context.vanillaLayer ? [context.vanillaLayer.source] : [])
  ];
}

function legacyReferenceEvidence(
  context: ResourcePackProjectContextDto,
  resolution: LegacyReferenceResolution
): LegacyReferenceEvidence {
  if (!resolution.reliable) {
    return "unavailable";
  }
  if (!resolution.winner) {
    return "miss";
  }
  try {
    return isResourceProjectUriWithin(resolution.winner.toString(), context.localLayer.rootUri)
      ? "localWinner"
      : "otherWinner";
  } catch {
    return "otherWinner";
  }
}
