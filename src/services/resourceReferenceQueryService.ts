import * as vscode from "vscode";
import {
  canonicalizeResourceGraphIdentity,
  canonicalizeResourceGraphOutputPath,
  uniqueLogicalKeys,
  type ResourceGraphLogicalKey
} from "../../packages/mc-assets/src";
import type { ResourceProducer } from "../resourceUniverse/core/types";
import type { ResourceUniverseService } from "../resourceUniverse/core/resourceUniverseService";
import { physicalProviderId } from "../resourceUniverse/core/providerIds";
import type { PhysicalAssetDefinitionResolver } from "../resourceUniverse/providers/physicalAssetDefinitionResolver";
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
      && !generatedFactsAreApplicable
      && this.physicalDefinitionResolver
    ) {
      try {
        const exact = await this.physicalDefinitionResolver.resolveExactDefinition({
          context: discovered.context,
          target: identity.primaryKey,
          scope: "effective"
        }, options.signal);
        if (exact.status === "resolved") {
          return {
            target: exact.target,
            targetUri: vscode.Uri.parse(exact.definition.uri, true),
            coverage: "authoritative"
          };
        }
        if (exact.status === "missing") {
          return { target: exact.target, targetUri: null, coverage: "authoritative" };
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
