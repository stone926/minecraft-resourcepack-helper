import * as vscode from "vscode";
import {
  canonicalizeResourceGraphIdentity,
  canonicalizeResourceGraphOutputPath,
  uniqueLogicalKeys,
  type ResourceGraphLogicalKey
} from "../../packages/mc-assets/src";
import type { ResourcePackProjectContextDto } from "../../packages/resource-project/src";
import type { ResourceProducer } from "../resourceUniverse/core/types";
import type { ResourceUniverseService } from "../resourceUniverse/core/resourceUniverseService";
import { projectProviderCoverage } from "../resourceUniverse/core/providerCoverage";
import { physicalProviderId, rsglGeneratedProviderId } from "../resourceUniverse/core/providerIds";
import type {
  PhysicalAssetDefinitionResolution,
  PhysicalAssetDefinitionResolver
} from "../resourceUniverse/providers/physicalAssetDefinitionResolver";
import type {
  ResourceNavigationResult,
  ResourceNavigationService
} from "../resourceUniverse/navigation/resourceNavigationService";
import { getResourceReferences, type ResourceReference } from "../utils/resourceReferences";
import { generateReferenceRedirectPath } from "../utils/pathGenerator";
import { isAbortError } from "../utils/abortError";
import {
  resourceReferenceForEdge,
  resourceSourceUriForEdge
} from "./resourceEdgeReferenceMapper";
import { combineResourceFactsCoverage as combineCoverage } from "./resourceFactsCoverage";
import { createResourceResolutionContext } from "./resourceNavigationContext";
import type { ProjectRefreshCoordinator } from "./projectRefreshCoordinator";
import type {
  EnsuredResourceProject,
  ResourceUniverseDocument,
  UnifiedReferenceResolution,
  UnifiedReferenceSet,
  UnifiedResolvedReference,
  UnifiedResourceQueryOptions
} from "./resourceUniverseNavigation";

/** Resource-reference extraction and indexed incoming/outgoing query orchestration. */
export class ResourceReferenceQueryService {
  private physicalDefinitionResolver?: PhysicalAssetDefinitionResolver;

  public constructor(
    private readonly universe: ResourceUniverseService,
    private readonly navigation: ResourceNavigationService,
    private readonly refreshCoordinator: ProjectRefreshCoordinator
  ) {}

  public setPhysicalDefinitionResolver(resolver: PhysicalAssetDefinitionResolver): void {
    this.physicalDefinitionResolver = resolver;
  }

  public async resolveReference(
    document: ResourceUniverseDocument,
    reference: ResourceReference,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<UnifiedReferenceResolution> {
    if (reference.value.startsWith("#")) {
      return { targetUri: null, coverage: "authoritative" };
    }

    const identity = canonicalizeResourceGraphIdentity(reference.kind, reference.value, {
      extension: reference.extension
    });
    const modeResolution = resolveModeReference(document, reference);
    if (modeResolution.handled) {
      return {
        target: identity?.primaryKey,
        targetUri: modeResolution.targetUri,
        coverage: "authoritative"
      };
    }

    const discovered = await this.refreshCoordinator.discoverProjectForUri(document.uri);
    if (!identity) {
      return {
        targetUri: null,
        coverage: discovered.context ? "authoritative" : "unavailable"
      };
    }

    const currentCoverage = discovered.context
      ? this.universe.getCoverage(physicalProviderId, discovered.context.projectId)
      : undefined;
    const currentIndexIsUsable = discovered.context !== undefined
      && this.refreshCoordinator.isPhysicalIndexCurrent(discovered.context)
      && currentCoverage !== undefined
      && currentCoverage.status !== "unavailable";
    const generatedFactsAreApplicable = options.includeGenerated === true
      && discovered.rsglApplicability !== "none";
    if (
      discovered.context
      && !currentIndexIsUsable
      && this.physicalDefinitionResolver
    ) {
      try {
        const exact = await this.physicalDefinitionResolver.resolveExactDefinition({
          context: discovered.context,
          target: identity.primaryKey,
          scope: "effective"
        }, options.signal);
        if (exact.status === "resolved" || exact.status === "missing") {
          if (!generatedFactsAreApplicable) {
            return exactPhysicalResolution(exact);
          }
          const hybrid = this.resolveWithCurrentGeneratedFacts(
            document,
            discovered.context,
            exact
          );
          if (hybrid) {
            return hybrid;
          }
        }
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) {
          throw error;
        }
        // An incomplete exact probe falls through to the canonical provider index.
      }
    }

    const ensured = await this.refreshCoordinator.refreshDiscoveredProject(discovered, options);
    return this.resolveIndexedReference(
      document,
      identity.primaryKey,
      ensured,
      this.refreshCoordinator.applicableProviderIds(
        options.includeGenerated === true,
        ensured.context?.projectId,
        ensured.rsglApplicability
      )
    );
  }

  /**
   * Combines one authoritative physical probe with only the already-indexed
   * generated facts for the same target. Equal-layer candidates deliberately
   * fall back to the coupled refresh because ownership and conflict projection
   * must remain atomic in that case.
   */
  private resolveWithCurrentGeneratedFacts(
    document: ResourceUniverseDocument,
    context: ResourcePackProjectContextDto,
    exact: Extract<PhysicalAssetDefinitionResolution, { status: "resolved" | "missing" }>
  ): UnifiedReferenceResolution | undefined {
    const generatedCoverage = projectProviderCoverage(
      this.universe.getCoverage(rsglGeneratedProviderId, context.projectId),
      context.projectId,
      "effective",
      exact.target
    );
    if (generatedCoverage === "unavailable") {
      return undefined;
    }

    const layerPriorities = effectiveLayerPriorities(context);
    const generatedCandidates = generatedCoverage === "notApplicable"
      ? []
      : this.universe.getProducersForKey(exact.target).filter(producer =>
          producer.projectId === context.projectId
          && producer.providerId === rsglGeneratedProviderId
        );
    if (generatedCandidates.length === 0) {
      return exactPhysicalResolution(exact);
    }

    const generatedPriorities = generatedCandidates.map(candidate =>
      layerPriorities.get(candidate.layerId)
    );
    if (generatedPriorities.some(priority => priority === undefined)) {
      // The generated snapshot belongs to an older layer topology.
      return undefined;
    }
    const generatedPriority = Math.min(...generatedPriorities as number[]);
    const physicalPriority = exact.status === "resolved"
      ? layerPriorities.get(exact.definition.layer.layerId)
      : undefined;
    if (exact.status === "resolved" && physicalPriority === undefined) {
      return undefined;
    }
    if (physicalPriority !== undefined && physicalPriority < generatedPriority) {
      return exactPhysicalResolution(exact);
    }
    if (physicalPriority === generatedPriority) {
      // Same-layer physical/generated producers may be a materialization or a
      // genuine conflict. Only the coupled provider refresh can distinguish it.
      return undefined;
    }

    const navigation = this.navigation.resolveDefinition(
      exact.target,
      createResourceResolutionContext(context, [rsglGeneratedProviderId]),
      { activeUri: document.uri.toString() }
    );
    if (navigation.status === "incomplete") {
      return undefined;
    }
    if (navigation.status === "missing") {
      // The snapshot may have been atomically replaced between the candidate
      // lookup and resolution; the exact physical evidence is still current.
      return exactPhysicalResolution(exact);
    }
    return {
      target: exact.target,
      targetUri: resolvedLocationUri(navigation),
      coverage: "authoritative",
      navigation
    };
  }

  public async getOutgoingReferences(
    document: ResourceUniverseDocument,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<UnifiedReferenceSet> {
    const ensured = await this.refreshCoordinator.ensureProjectForUri(document.uri, options);
    const applicableProviderIds = this.refreshCoordinator.applicableProviderIds(
      options.includeGenerated === true,
      ensured.context?.projectId,
      ensured.rsglApplicability
    );
    const resolutions = getResourceReferences(document).map(reference => {
      if (reference.value.startsWith("#")) {
        return {
          reference,
          resolution: { targetUri: null, coverage: "authoritative" as const }
        };
      }
      const identity = canonicalizeResourceGraphIdentity(reference.kind, reference.value, {
        extension: reference.extension
      });
      const modeResolution = resolveModeReference(document, reference);
      if (modeResolution.handled) {
        return {
          reference,
          resolution: {
            target: identity?.primaryKey,
            targetUri: modeResolution.targetUri,
            coverage: "authoritative" as const
          }
        };
      }
      return {
        reference,
        resolution: this.resolveIndexedReference(
          document,
          identity?.primaryKey,
          ensured,
          applicableProviderIds
        )
      };
    });
    return {
      references: resolutions.map(({ reference, resolution }) => ({
        reference,
        sourceUri: document.uri,
        targetUri: resolution.targetUri,
        target: resolution.target,
        targetProducer: resolvedProducer(resolution.navigation),
        navigation: resolution.navigation
      })),
      coverage: combineCoverage([
        ensured.coverage,
        ...resolutions.map(item => item.resolution.coverage)
      ])
    };
  }

  private resolveIndexedReference(
    document: ResourceUniverseDocument,
    target: ResourceGraphLogicalKey | undefined,
    ensured: EnsuredResourceProject,
    applicableProviderIds: readonly string[]
  ): UnifiedReferenceResolution {
    if (!target || !ensured.context) {
      return {
        target,
        targetUri: null,
        coverage: ensured.context ? ensured.coverage : "unavailable"
      };
    }
    const navigation = this.navigation.resolveDefinition(
      target,
      createResourceResolutionContext(ensured.context, applicableProviderIds),
      { activeUri: document.uri.toString() }
    );
    return {
      target,
      targetUri: resolvedLocationUri(navigation),
      coverage: ensured.coverage,
      navigation
    };
  }

  public async getIncomingReferences(
    uri: vscode.Uri,
    relationship?: string,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<UnifiedReferenceSet> {
    const ensured = await this.refreshCoordinator.ensureProjectForUri(uri, options);
    const identity = canonicalizeResourceGraphOutputPath(
      uri.scheme === "file" ? uri.fsPath : uri.path,
      { fileSystemCaseSensitive: uri.scheme !== "file" }
    );
    if (!identity) {
      return { references: [], coverage: "unavailable" };
    }
    const edges = ensured.context
      ? this.universe.getIncoming(identity.primaryKey)
          .filter(edge => edge.projectId === ensured.context!.projectId)
          .filter(edge => relationship === undefined || edge.relationship === relationship)
      : [];
    return {
      references: edges.flatMap(edge => {
        const sourceProducer = this.universe.getProducer(edge.sourceProducerId);
        const reference = resourceReferenceForEdge(edge);
        const sourceUri = resourceSourceUriForEdge(edge, sourceProducer);
        return reference && sourceUri ? [{
          reference,
          sourceUri: vscode.Uri.parse(sourceUri, true),
          targetUri: uri,
          target: edge.target,
          sourceRange: edge.sourceLocation?.range,
          sourceProducer
        }] : [];
      }),
      coverage: ensured.coverage
    };
  }

  public async getProducerOutgoingReferences(
    producerId: string,
    options: UnifiedResourceQueryOptions = { includeGenerated: true }
  ): Promise<UnifiedReferenceSet> {
    const producer = this.universe.getProducer(producerId);
    if (!producer) {
      return { references: [], coverage: "unavailable" };
    }
    const ensured = await this.refreshCoordinator.ensureProducerProject(producer, options);
    const current = this.universe.getProducer(producerId) ?? producer;
    if (!ensured.context) {
      return { references: [], coverage: ensured.coverage };
    }
    const references = this.universe.getOutgoing(current.producerId).flatMap(edge => {
      const reference = resourceReferenceForEdge(edge);
      const sourceUri = resourceSourceUriForEdge(edge, current);
      if (!reference || !sourceUri) {
        return [];
      }
      const navigation = this.navigation.resolveDefinition(
        edge.target,
        createResourceResolutionContext(
          ensured.context!,
          this.refreshCoordinator.applicableProviderIds(
            options.includeGenerated === true,
            ensured.context!.projectId,
            ensured.rsglApplicability
          )
        ),
        { activeUri: edge.sourceLocation?.uri }
      );
      return [{
        reference,
        sourceUri: vscode.Uri.parse(sourceUri, true),
        targetUri: resolvedLocationUri(navigation),
        target: edge.target,
        sourceRange: edge.sourceLocation?.range,
        sourceProducer: current,
        targetProducer: resolvedProducer(navigation),
        navigation
      }];
    });
    return { references: uniqueResolvedReferences(references), coverage: ensured.coverage };
  }

  public async getProducerIncomingReferences(
    producerId: string,
    relationship?: string,
    options: UnifiedResourceQueryOptions = { includeGenerated: true }
  ): Promise<UnifiedReferenceSet> {
    const producer = this.universe.getProducer(producerId);
    if (!producer) {
      return { references: [], coverage: "unavailable" };
    }
    const ensured = await this.refreshCoordinator.ensureProducerProject(producer, options);
    const current = this.universe.getProducer(producerId) ?? producer;
    const references = uniqueLogicalKeys(current.logicalKeys).flatMap(target =>
      this.universe.getIncoming(target)
        .filter(edge => edge.projectId === current.projectId)
        .filter(edge => relationship === undefined || edge.relationship === relationship)
        .flatMap(edge => {
          const sourceProducer = this.universe.getProducer(edge.sourceProducerId);
          const reference = resourceReferenceForEdge(edge);
          const sourceUri = resourceSourceUriForEdge(edge, sourceProducer);
          const targetUri = preferredProducerUri(current);
          return reference && sourceUri ? [{
            reference,
            sourceUri: vscode.Uri.parse(sourceUri, true),
            targetUri,
            target,
            sourceRange: edge.sourceLocation?.range,
            sourceProducer,
            targetProducer: current
          }] : [];
        })
    );
    return { references: uniqueResolvedReferences(references), coverage: ensured.coverage };
  }
}

type ModeReferenceResolution =
  | { handled: false; targetUri: null }
  | { handled: true; targetUri: vscode.Uri | null };

/** Specialized path modes (currently CIT) remain outside logical physical resolution. */
function resolveModeReference(
  document: ResourceUniverseDocument,
  reference: ResourceReference
): ModeReferenceResolution {
  if (!reference.resolveMode || document.uri.scheme !== "file") {
    return { handled: false, targetUri: null };
  }
  try {
    return {
      handled: true,
      targetUri: generateReferenceRedirectPath(reference, document)
    };
  } catch {
    return { handled: false, targetUri: null };
  }
}

function resolvedProducer(result: ResourceNavigationResult | undefined): ResourceProducer | undefined {
  return result?.status === "resolved" ? result.producer : undefined;
}

function resolvedLocationUri(result: ResourceNavigationResult): vscode.Uri | null {
  return result.status === "resolved" ? vscode.Uri.parse(result.primary.uri, true) : null;
}

function exactPhysicalResolution(
  exact: Extract<PhysicalAssetDefinitionResolution, { status: "resolved" | "missing" }>
): UnifiedReferenceResolution {
  return {
    target: exact.target,
    targetUri: exact.status === "resolved"
      ? vscode.Uri.parse(exact.definition.uri, true)
      : null,
    coverage: "authoritative"
  };
}

function effectiveLayerPriorities(
  context: ResourcePackProjectContextDto
): ReadonlyMap<string, number> {
  return new Map([
    context.localLayer,
    ...context.externalLayers,
    ...(context.vanillaLayer ? [context.vanillaLayer] : [])
  ].map((layer, index) => [layer.layerId, index]));
}

function preferredProducerUri(producer: ResourceProducer): vscode.Uri | null {
  const uri = producer.sourceOrigins[0]?.uri ?? producer.physicalOrigins[0]?.uri;
  return uri ? vscode.Uri.parse(uri, true) : null;
}

function uniqueResolvedReferences(
  references: readonly UnifiedResolvedReference[]
): UnifiedResolvedReference[] {
  return [...new Map(references.map(reference => [[
    reference.sourceProducer?.producerId ?? reference.sourceUri.toString(),
    reference.sourceRange?.start ?? "",
    reference.sourceRange?.end ?? "",
    reference.target?.kind ?? "",
    reference.target?.id ?? ""
  ].join("\0"), reference])).values()];
}
