import * as vscode from "vscode";
import {
  minecraftReferenceKindForResourceKind,
  canonicalizeResourceGraphIdentity,
  canonicalizeResourceGraphOutputPath,
  minecraftResourceTarget,
  uniqueLogicalKeys,
  type ResourceGraphLogicalKey
} from "../../packages/mc-assets/src";
import {
  isResourceProjectUriWithin,
  type ResourceLayerSource,
  type ResourcePackProjectContextDto
} from "../../packages/resource-project/src";
import type {
  ResourcePackProjectService,
  RsglProjectApplicability
} from "../resourceProject";
import type {
  ResourceDocumentProjection,
  ProviderCoverage,
  ResourceEdge,
  ResourceLocation,
  ResourceProducer,
  ResourceProviderUnavailableReason,
  ResourceResolutionContext,
  ResourceResolutionScope
} from "../resourceUniverse/core/types";
import type {
  ResourceUniverseChangeEvent,
  ResourceUniverseService
} from "../resourceUniverse/core/resourceUniverseService";
import {
  ResourceNavigationService,
  type ResourceNavigationOptions,
  type ResourceNavigationResult
} from "../resourceUniverse/navigation/resourceNavigationService";
import { resourceUriComparisonIdentity } from "../resourceUniverse/core/resourceUriIdentity";
import { physicalProviderId, rsglGeneratedProviderId } from "../resourceUniverse/core/providerIds";
import type { PhysicalAssetDefinitionResolver } from "../resourceUniverse/providers/physicalAssetDefinitionResolver";
import {
  generateReferenceRedirectPath,
  type ResourceReferencePathResolver
} from "../utils/pathGenerator";
import { isAbortError } from "../utils/abortError";
import {
  getResourceReferences,
  isResourceReferenceKind,
  type ResourceReference,
  type ResourceReferenceDocument
} from "../utils/resourceReferences";
import { ResourceProjectUniverseInvalidator } from "./resourceProjectUniverseInvalidator";
import { isRsglDocument } from "../rsgl/rsglActivationSignals";
import { shouldRequestGeneratedSnapshot } from "./generatedResourceRefreshPolicy";
import {
  requiresReferenceIndexRefresh,
  type LegacyReferenceEvidence
} from "./referenceIndexRefreshPolicy";
import {
  combineResourceFactsCoverage as combineCoverage,
  summarizeDocumentProviderFacts,
  summarizeGeneratedInventoryFacts,
  summarizeLocalPhysicalInventoryFacts,
  type ProviderFactsCoverage,
  type ResourceFactsCoverage
} from "./resourceFactsCoverage";

export type UnifiedResourceCoverage = ResourceFactsCoverage;

export interface UnifiedResolvedReference {
  reference: ResourceReference;
  sourceUri: vscode.Uri;
  targetUri: vscode.Uri | null;
  target?: ResourceGraphLogicalKey;
  sourceRange?: ResourceLocation["range"];
  sourceProducer?: ResourceProducer;
  targetProducer?: ResourceProducer;
  navigation?: ResourceNavigationResult;
}

export interface UnifiedReferenceSet {
  references: readonly UnifiedResolvedReference[];
  coverage: UnifiedResourceCoverage;
}

export interface UnifiedReferenceResolution {
  target?: ResourceGraphLogicalKey;
  targetUri: vscode.Uri | null;
  coverage: UnifiedResourceCoverage;
  navigation?: ResourceNavigationResult;
}

export interface EnsuredResourceProject {
  context?: ResourcePackProjectContextDto;
  coverage: UnifiedResourceCoverage;
  rsglApplicability?: RsglProjectApplicability;
}

export interface UnifiedDocumentProjection {
  applicable: boolean;
  context?: ResourcePackProjectContextDto;
  projections: readonly ResourceDocumentProjection[];
  coverage: UnifiedResourceCoverage;
  providerCoverages: readonly UnifiedProviderFactsCoverage[];
}

export type UnifiedProviderFactsCoverage = ProviderFactsCoverage;

export interface UnifiedResourceProducerTarget {
  target: ResourceGraphLogicalKey;
  producer: ResourceProducer;
  candidates: readonly ResourceProducer[];
  resolutionStatus: ResourceNavigationResult["status"];
}

export interface UnifiedBlockResourceSet {
  resources: readonly UnifiedResourceProducerTarget[];
  coverage: UnifiedResourceCoverage;
}

export interface UnifiedResourceInventory {
  resources: readonly UnifiedResourceProducerTarget[];
  coverage: UnifiedResourceCoverage;
}

export interface UnifiedResourceInventoryOptions {
  signal?: AbortSignal;
  /** Restricts inventory to projects explicitly discovered for this consumer. */
  projectIds?: readonly string[];
  /** Correlates provider changes requested while assembling this inventory. */
  causeId?: symbol;
}

export interface UnifiedResourceQueryOptions {
  /** Explicit graph/Definition/References requests may opt into the lazy RSGL provider. */
  includeGenerated?: boolean;
  signal?: AbortSignal;
  /** Correlates provider changes requested by this query. */
  causeId?: symbol;
}

export interface UnifiedLogicalDefinitionResolution {
  context?: ResourcePackProjectContextDto;
  coverage: UnifiedResourceCoverage;
  /** Exact physical result; an empty array is an authoritative target miss. */
  directLocations?: readonly ResourceLocation[];
  navigation?: ResourceNavigationResult;
}

export interface UnifiedLogicalReferenceLocations {
  context?: ResourcePackProjectContextDto;
  coverage: UnifiedResourceCoverage;
  locations: readonly ResourceLocation[];
}

export type GeneratedResourceProjectRefresher = (
  projectId: string,
  signal?: AbortSignal,
  causeId?: symbol
) => Promise<unknown>;

export interface ResourceUniverseDocument extends ResourceReferenceDocument {
  readonly uri: vscode.Uri;
}

/**
 * Public navigation contract consumed by extension surfaces. Keeping callers
 * on this structural interface lets activation provide a typed lazy adapter
 * without exposing the concrete project/universe implementation.
 */
export interface ResourceUniverseNavigation {
  setGeneratedProjectRefresher(refresher: GeneratedResourceProjectRefresher): void;
  onDidChangeResources(listener: (event: ResourceUniverseChangeEvent) => void): vscode.Disposable;
  resolveReference(
    document: ResourceUniverseDocument,
    reference: ResourceReference,
    options?: UnifiedResourceQueryOptions
  ): Promise<UnifiedReferenceResolution>;
  resolveLogicalDefinition(
    sourceUri: vscode.Uri,
    target: ResourceGraphLogicalKey,
    scope: ResourceResolutionScope,
    options?: Omit<UnifiedResourceQueryOptions, "includeGenerated">
  ): Promise<UnifiedLogicalDefinitionResolution>;
  getLogicalIncomingReferenceLocations(
    sourceUri: vscode.Uri,
    target: ResourceGraphLogicalKey,
    options?: Omit<UnifiedResourceQueryOptions, "includeGenerated">
  ): Promise<UnifiedLogicalReferenceLocations>;
  getOutgoingReferences(
    document: ResourceUniverseDocument,
    options?: UnifiedResourceQueryOptions
  ): Promise<UnifiedReferenceSet>;
  getIncomingReferences(
    uri: vscode.Uri,
    relationship?: string,
    options?: UnifiedResourceQueryOptions
  ): Promise<UnifiedReferenceSet>;
  ensureProjectForUri(
    uri: vscode.Uri,
    options?: UnifiedResourceQueryOptions
  ): Promise<EnsuredResourceProject>;
  getDocumentProjection(document: ResourceUniverseDocument): Promise<UnifiedDocumentProjection>;
  getKnownResources(
    kinds: readonly string[],
    options?: UnifiedResourceInventoryOptions
  ): Promise<UnifiedResourceInventory>;
  /**
   * Rebinds a previously selected producer to the current in-memory Universe
   * snapshot without triggering project discovery or provider refresh work.
   */
  getKnownResource(
    producerId: string,
    target: ResourceGraphLogicalKey
  ): UnifiedResourceProducerTarget | undefined;
  getProducerOutgoingReferences(
    producerId: string,
    options?: UnifiedResourceQueryOptions
  ): Promise<UnifiedReferenceSet>;
  getProducerIncomingReferences(
    producerId: string,
    relationship?: string,
    options?: UnifiedResourceQueryOptions
  ): Promise<UnifiedReferenceSet>;
  resolveProducerNavigation(
    producerId: string,
    target: ResourceGraphLogicalKey,
    options?: ResourceNavigationOptions & UnifiedResourceQueryOptions
  ): Promise<ResourceNavigationResult | undefined>;
  resolveUriNavigation(
    uri: vscode.Uri,
    options?: ResourceNavigationOptions & UnifiedResourceQueryOptions
  ): Promise<ResourceNavigationResult | undefined>;
  invalidateUri(uri: vscode.Uri): readonly string[];
  invalidateAllKnownProjects(): void;
}

interface DiscoveredResourceProject {
  readonly context?: ResourcePackProjectContextDto;
  readonly rsglApplicability?: RsglProjectApplicability;
}

interface LegacyReferenceResolution {
  readonly winner: vscode.Uri | null;
  readonly reliable: boolean;
}

/**
 * Compatibility bridge for the visible migration. The legacy filesystem
 * resolver remains the physical winner oracle on local files, while producer
 * and origin selection is performed by ResourceUniverse/NavigationService.
 */
export class ResourceUniverseNavigationFacade implements ResourceUniverseNavigation {
  private readonly navigation: ResourceNavigationService;
  private readonly invalidator: ResourceProjectUniverseInvalidator;
  private readonly refreshedContextRevisions = new Map<string, string>();
  private generatedProjectRefresher?: GeneratedResourceProjectRefresher;
  private physicalDefinitionResolver?: PhysicalAssetDefinitionResolver;

  public constructor(
    private readonly projects: ResourcePackProjectService,
    private readonly universe: ResourceUniverseService,
    private readonly legacyResolver: ResourceReferencePathResolver = generateReferenceRedirectPath
  ) {
    this.navigation = new ResourceNavigationService(universe.index);
    this.invalidator = new ResourceProjectUniverseInvalidator(projects, universe);
  }

  /** Late-bound because the lazy RSGL subsystem is composed after core infrastructure. */
  public setGeneratedProjectRefresher(refresher: GeneratedResourceProjectRefresher): void {
    this.generatedProjectRefresher = refresher;
  }

  /** Late-bound to avoid making project scanning part of facade construction. */
  public setPhysicalDefinitionResolver(resolver: PhysicalAssetDefinitionResolver): void {
    this.physicalDefinitionResolver = resolver;
  }

  public onDidChangeResources(
    listener: (event: ResourceUniverseChangeEvent) => void
  ): { dispose(): void } {
    return this.universe.onDidChange(listener);
  }

  public async resolveReference(
    document: ResourceUniverseDocument,
    reference: ResourceReference,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<UnifiedReferenceResolution> {
    if (reference.value.startsWith("#")) {
      return { targetUri: null, coverage: "authoritative" };
    }

    const legacy = this.tryResolveLegacyReference(document, reference);
    const identity = canonicalizeResourceGraphIdentity(reference.kind, reference.value, {
      extension: reference.extension
    });
    const discovered = await this.discoverProjectForUri(document.uri);
    if (discovered.context && !requiresReferenceIndexRefresh({
      documentScheme: document.uri.scheme,
      rsglApplicability: discovered.rsglApplicability,
      legacyEvidence: legacyReferenceEvidence(discovered.context, legacy),
      layerSources: projectLayerSources(discovered.context)
    })) {
      return {
        target: identity?.primaryKey,
        targetUri: legacy.winner,
        coverage: "authoritative"
      };
    }

    const ensured = await this.refreshDiscoveredProject(discovered, options);
    return this.resolveIndexedReference(document, identity?.primaryKey, legacy.winner, ensured, options);
  }

  /**
   * Resolves one compiler-owned canonical target through the main physical
   * Universe. This seam is used by the LSP's server-to-client navigation
   * request and deliberately never refreshes the generated provider, avoiding
   * a request cycle while the language server is waiting for its client.
   */
  public async resolveLogicalDefinition(
    sourceUri: vscode.Uri,
    target: ResourceGraphLogicalKey,
    scope: ResourceResolutionScope,
    options: Omit<UnifiedResourceQueryOptions, "includeGenerated"> = {}
  ): Promise<UnifiedLogicalDefinitionResolution> {
    const discovered = await this.discoverProjectForUri(sourceUri);
    if (!discovered.context) {
      return { coverage: "unavailable" };
    }

    const currentCoverage = this.universe.getCoverage(
      physicalProviderId,
      discovered.context.projectId
    );
    const currentIndexIsUsable = this.refreshedContextRevisions.get(discovered.context.projectId)
      === discovered.context.contextRevision
      && currentCoverage !== undefined
      && currentCoverage.status !== "unavailable";
    if (!currentIndexIsUsable && this.physicalDefinitionResolver) {
      try {
        const exact = await this.physicalDefinitionResolver.resolveExactDefinition({
          context: discovered.context,
          target,
          scope
        }, options.signal);
        if (exact.status === "resolved") {
          return {
            context: discovered.context,
            coverage: "authoritative",
            directLocations: [{
              uri: exact.definition.uri,
              origin: "physical"
            }]
          };
        }
        if (exact.status === "missing") {
          return {
            context: discovered.context,
            coverage: "authoritative",
            directLocations: []
          };
        }
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) {
          throw error;
        }
        // An optimization failure must retain the complete provider/index path.
      }
    }

    const ensured = await this.refreshDiscoveredProject(discovered, {
      ...options,
      includeGenerated: false
    });
    if (!ensured.context) {
      return { coverage: ensured.coverage };
    }
    const providerIds = this.applicableProviderIds(false, ensured.context.projectId);
    return {
      context: ensured.context,
      coverage: ensured.coverage,
      navigation: this.navigation.resolveDefinition(
        target,
        resolutionContext(ensured.context, providerIds, scope),
        { activeUri: sourceUri.toString() }
      )
    };
  }

  /** Returns only physical consumers; RSGL references are already in the LSP analysis. */
  public async getLogicalIncomingReferenceLocations(
    sourceUri: vscode.Uri,
    target: ResourceGraphLogicalKey,
    options: Omit<UnifiedResourceQueryOptions, "includeGenerated"> = {}
  ): Promise<UnifiedLogicalReferenceLocations> {
    const ensured = await this.ensureProjectForUri(sourceUri, {
      ...options,
      includeGenerated: false
    });
    if (!ensured.context) {
      return { coverage: ensured.coverage, locations: [] };
    }
    const locations = this.universe.getIncoming(target)
      .filter(edge => edge.projectId === ensured.context!.projectId && edge.providerId === physicalProviderId)
      .flatMap(edge => {
        if (edge.sourceLocation) {
          return [edge.sourceLocation];
        }
        const producer = this.universe.getProducer(edge.sourceProducerId);
        return producer
          ? [...producer.sourceOrigins, ...producer.physicalOrigins].slice(0, 1)
          : [];
      });
    return {
      context: ensured.context,
      coverage: ensured.coverage,
      locations: uniqueResourceLocations(locations)
    };
  }

  public async getOutgoingReferences(
    document: ResourceUniverseDocument,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<UnifiedReferenceSet> {
    // Graph queries explicitly consume indexed producers/edges, so they keep
    // the full refresh even when a Definition lookup could use the bounded
    // directory-only fast path.
    const ensured = await this.ensureProjectForUri(document.uri, options);
    const resolutions = getResourceReferences(document).map(reference => {
      if (reference.value.startsWith("#")) {
        return {
          reference,
          resolution: { targetUri: null, coverage: "authoritative" as const }
        };
      }
      const legacyWinner = this.tryResolveLegacyReference(document, reference).winner;
      const identity = canonicalizeResourceGraphIdentity(reference.kind, reference.value, {
        extension: reference.extension
      });
      return {
        reference,
        resolution: this.resolveIndexedReference(
          document,
          identity?.primaryKey,
          legacyWinner,
          ensured,
          options
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

  public async getIncomingReferences(
    uri: vscode.Uri,
    relationship?: string,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<UnifiedReferenceSet> {
    const ensured = await this.ensureProjectForUri(uri, options);
    const identity = canonicalizeResourceGraphOutputPath(
      uri.scheme === "file" ? uri.fsPath : uri.path,
      { fileSystemCaseSensitive: uri.scheme !== "file" }
    );
    if (!identity) {
      // Shader includes and extension-bearing font files do not yet have an
      // unambiguous output-path identity; keep the legacy incoming index for
      // those surfaces until their canonical key model is extended.
      return { references: [], coverage: "unavailable" };
    }
    const edges = ensured.context
      ? this.universe.getIncoming(identity.primaryKey)
        .filter(edge => edge.projectId === ensured.context!.projectId)
        .filter(edge => relationship === undefined || edge.relationship === relationship)
      : [];
    return {
      references: edges.flatMap(edge => {
        const reference = this.referenceForEdge(edge);
        const sourceUri = this.sourceUriForEdge(edge);
        const sourceProducer = this.universe.getProducer(edge.sourceProducerId);
        return reference && sourceUri ? [{
          reference,
          sourceUri,
          targetUri: uri,
          target: edge.target,
          sourceRange: edge.sourceLocation?.range,
          sourceProducer
        }] : [];
      }),
      coverage: ensured.coverage
    };
  }

  public async ensureProjectForUri(
    uri: vscode.Uri,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<EnsuredResourceProject> {
    const discovered = await this.discoverProjectForUri(uri);
    return this.refreshDiscoveredProject(discovered, options);
  }

  private async discoverProjectForUri(uri: vscode.Uri): Promise<DiscoveredResourceProject> {
    try {
      const result = await this.projects.resolveProject(uri.toString());
      return {
        context: result.context,
        rsglApplicability: result.rsglApplicability
      };
    } catch {
      return {};
    }
  }

  private async refreshDiscoveredProject(
    discovered: DiscoveredResourceProject,
    options: UnifiedResourceQueryOptions
  ): Promise<EnsuredResourceProject> {
    const context = discovered.context;
    if (!context) {
      return {
        coverage: "unavailable",
        rsglApplicability: discovered.rsglApplicability
      };
    }

    let coverage = this.universe.getCoverage(physicalProviderId, context.projectId);
    const contextIsCurrent = this.refreshedContextRevisions.get(context.projectId)
      === context.contextRevision;
    if (!contextIsCurrent || !coverage || coverage.status === "unavailable") {
      try {
        // The physical provider scans the whole project. Keep this canonical
        // scope aligned with coupled generated/physical refreshes so identical
        // work can share one in-flight snapshot.
        const refresh = await this.universe.refreshProviderProject(
          "physical",
          context.projectId,
          { projectId: context.projectId },
          options.signal,
          options.causeId
        );
        if (refresh.applied) {
          this.refreshedContextRevisions.set(context.projectId, context.contextRevision);
        }
      } catch (error) {
        if (!isAbortError(error) && !options.signal?.aborted) {
          this.invalidateProviderProject(
            "physical",
            context.projectId,
            "stale",
            options.causeId
          );
        }
      }
      coverage = this.universe.getCoverage(physicalProviderId, context.projectId);
    }
    const coverages: UnifiedResourceCoverage[] = [visibleCoverage(coverage)];
    if (options.includeGenerated && discovered.rsglApplicability !== "none") {
      coverages.push(await this.ensureGeneratedProject(
        context.projectId,
        options.signal,
        options.causeId
      ));
    }
    return {
      context,
      coverage: combineCoverage(coverages),
      rsglApplicability: discovered.rsglApplicability
    };
  }

  /** Provider-aware Current File projection. Handler discovery itself performs no I/O. */
  public async getDocumentProjection(
    document: ResourceUniverseDocument
  ): Promise<UnifiedDocumentProjection> {
    const descriptor = {
      uri: document.uri.toString(),
      fileName: document.fileName,
      languageId: document.languageId
    };
    const providerIds = this.universe.getDocumentProviderIds(descriptor);
    const generatedDocument = isGeneratedResourceDocument(document);
    if (providerIds.length === 0 && !generatedDocument) {
      return {
        applicable: false,
        projections: [],
        coverage: "authoritative",
        providerCoverages: []
      };
    }
    const includeGenerated = generatedDocument || providerIds.includes(rsglGeneratedProviderId);
    const ensured = await this.ensureProjectForUri(document.uri, { includeGenerated });
    if (!ensured.context) {
      return {
        applicable: true,
        projections: [],
        coverage: ensured.coverage,
        providerCoverages: []
      };
    }
    const projections = this.universe.getDocumentProjections(
      descriptor,
      ensured.context.projectId
    );
    const providerCoverages = projections.map(projection =>
      summarizeDocumentProviderFacts(
        projection.providerId,
        this.universe.getCoverage(projection.providerId, ensured.context!.projectId),
        descriptor.uri
      )
    );
    return {
      context: ensured.context,
      applicable: true,
      projections,
      coverage: combineCoverage(providerCoverages.map(item => item.coverage)),
      providerCoverages
    };
  }

  /** Deferred global Blocks projection over already-discovered project contexts. */

  /** Deferred local-project inventory over already-discovered project contexts. */
  public async getKnownResources(
    kinds: readonly string[],
    options: UnifiedResourceInventoryOptions = {}
  ): Promise<UnifiedResourceInventory> {
    const scopedProjectIds = options.projectIds
      ? new Set(options.projectIds)
      : null;
    const contexts = this.projects.getCachedContexts()
      .filter(context => !scopedProjectIds || scopedProjectIds.has(context.projectId));
    const requestedKinds = new Set(kinds);
    const cachedProjectIds = new Set(contexts.map(context => context.projectId));
    const coverages: UnifiedResourceCoverage[] = scopedProjectIds
      ? [...scopedProjectIds]
          .filter(projectId => !cachedProjectIds.has(projectId))
          .map(() => "unavailable" as const)
      : [];
    const resources: UnifiedResourceProducerTarget[] = [];
    for (const context of contexts) {
      if (options.signal?.aborted) {
        break;
      }
      const anchor = vscode.Uri.parse(context.projectRootUri, true);
      const ensured = await this.ensureProjectForUri(anchor, {
        includeGenerated: true,
        signal: options.signal,
        causeId: options.causeId
      });
      coverages.push(summarizeLocalPhysicalInventoryFacts(
        this.universe.getCoverage(physicalProviderId, context.projectId),
        context.outputPackRootUri
      ));
      if (ensured.rsglApplicability !== "none") {
        coverages.push(summarizeGeneratedInventoryFacts(
          this.universe.getCoverage(rsglGeneratedProviderId, context.projectId)
        ));
      }
      const targets = uniqueLogicalKeys(this.universe.getProjectProducers(context.projectId)
        .filter(producer => producer.layerRole === "local")
        .flatMap(producer => producer.logicalKeys)
        .filter(target => requestedKinds.has(target.kind)));
      for (const target of targets) {
        const navigation = this.navigation.resolveDefinition(
          target,
          resolutionContext(context, this.applicableProviderIds(
            true,
            context.projectId,
            ensured.rsglApplicability
          ))
        );
        resources.push(...projectNavigationResources(target, navigation));
      }
    }
    return {
      resources: uniqueProducerTargets(resources),
      coverage: combineCoverage(coverages)
    };
  }

  public getKnownResource(
    producerId: string,
    target: ResourceGraphLogicalKey
  ): UnifiedResourceProducerTarget | undefined {
    const producer = this.universe.getProducer(producerId);
    if (!producer) {
      return undefined;
    }
    const context = this.projects.getCachedContext(producer.projectId);
    if (!context) {
      return undefined;
    }
    const navigation = this.navigation.resolveDefinition(
      target,
      resolutionContext(
        context,
        this.applicableProviderIds(true, producer.projectId)
      )
    );
    return projectNavigationResources(target, navigation)
      .find(resource => resource.producer.producerId === producerId);
  }

  public async getProducerOutgoingReferences(
    producerId: string,
    options: UnifiedResourceQueryOptions = { includeGenerated: true }
  ): Promise<UnifiedReferenceSet> {
    const producer = this.universe.getProducer(producerId);
    if (!producer) {
      return { references: [], coverage: "unavailable" };
    }
    const ensured = await this.ensureProducerProject(producer, options);
    const current = this.universe.getProducer(producerId) ?? producer;
    const context = ensured.context;
    if (!context) {
      return { references: [], coverage: ensured.coverage };
    }
    const references = this.universe.getOutgoing(current.producerId).flatMap(edge => {
      const reference = this.referenceForEdge(edge);
      const sourceUri = this.sourceUriForEdge(edge);
      if (!reference || !sourceUri) {
        return [];
      }
      const navigation = this.navigation.resolveDefinition(
        edge.target,
        resolutionContext(
          context,
          this.applicableProviderIds(
            options.includeGenerated === true,
            context.projectId,
            ensured.rsglApplicability
          )
        ),
        { activeUri: edge.sourceLocation?.uri }
      );
      return [{
        reference,
        sourceUri,
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
    const ensured = await this.ensureProducerProject(producer, options);
    const current = this.universe.getProducer(producerId) ?? producer;
    const references = uniqueLogicalKeys(current.logicalKeys).flatMap(target =>
      this.universe.getIncoming(target)
        .filter(edge => edge.projectId === current.projectId)
        .filter(edge => relationship === undefined || edge.relationship === relationship)
        .flatMap(edge => {
          const reference = this.referenceForEdge(edge);
          const sourceUri = this.sourceUriForEdge(edge);
          const sourceProducer = this.universe.getProducer(edge.sourceProducerId);
          const targetUri = preferredProducerUri(current);
          return reference && sourceUri ? [{
            reference,
            sourceUri,
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

  public async resolveProducerNavigation(
    producerId: string,
    target: ResourceGraphLogicalKey,
    options: ResourceNavigationOptions & UnifiedResourceQueryOptions = {}
  ): Promise<ResourceNavigationResult | undefined> {
    const producer = this.universe.getProducer(producerId);
    if (!producer) {
      return undefined;
    }
    await this.ensureProducerProject(producer, options);
    const current = this.universe.getProducer(producerId) ?? producer;
    return this.navigation.resolveProducerDefinition(target, current, options);
  }

  public async resolveUriNavigation(
    uri: vscode.Uri,
    options: ResourceNavigationOptions & UnifiedResourceQueryOptions = {}
  ): Promise<ResourceNavigationResult | undefined> {
    const identity = canonicalizeResourceGraphOutputPath(
      uri.scheme === "file" ? uri.fsPath : uri.path,
      { fileSystemCaseSensitive: uri.scheme !== "file" }
    );
    const ensured = await this.ensureProjectForUri(uri, options);
    if (!identity || !ensured.context) {
      return undefined;
    }
    return this.navigation.resolveDefinition(
      identity.primaryKey,
      resolutionContext(
        ensured.context,
        this.applicableProviderIds(
          options.includeGenerated === true,
          ensured.context.projectId,
          ensured.rsglApplicability
        )
      ),
      options
    );
  }

  /** Synchronously marks already-known consumer projects stale. */
  public invalidateUri(uri: vscode.Uri): readonly string[] {
    return this.invalidator.invalidatePhysicalUri(uri.toString());
  }

  public invalidateAllKnownProjects(): void {
    this.invalidator.invalidateAllKnownProjects();
  }

  private resolveIndexedReference(
    document: ResourceUniverseDocument,
    target: ResourceGraphLogicalKey | undefined,
    legacyWinner: vscode.Uri | null,
    ensured: EnsuredResourceProject,
    options: UnifiedResourceQueryOptions
  ): UnifiedReferenceResolution {
    if (!target || !ensured.context) {
      return {
        target,
        targetUri: legacyWinner,
        coverage: ensured.context ? ensured.coverage : legacyWinner ? "authoritative" : "unavailable"
      };
    }

    // The existing resolver contains the complete directory-layer
    // overlay/filter/load-order and CIT compatibility policy. Reconcile a
    // concrete legacy winner with its producer; when it cannot represent an
    // archive layer, fall through to the Universe's ordered virtual origins.
    if (!options.includeGenerated && document.uri.scheme === "file" && legacyWinner) {
      const producer = this.findPhysicalProducer(target, ensured.context.projectId, legacyWinner);
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
      resolutionContext(
        ensured.context,
        this.applicableProviderIds(
          options.includeGenerated === true,
          ensured.context.projectId,
          ensured.rsglApplicability
        )
      ),
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

  private async ensureGeneratedProject(
    projectId: string,
    signal?: AbortSignal,
    causeId?: symbol
  ): Promise<UnifiedResourceCoverage> {
    if (signal?.aborted) {
      return visibleCoverage(this.universe.getCoverage(rsglGeneratedProviderId, projectId));
    }
    let requestedLazyRegistration = false;
    if (!this.universe.hasProvider(rsglGeneratedProviderId) && this.generatedProjectRefresher) {
      requestedLazyRegistration = true;
      try {
        await this.generatedProjectRefresher(projectId, signal, causeId);
      } catch (error) {
        if (!isAbortError(error) && !signal?.aborted) {
          this.invalidateProviderProject(
            "rsgl",
            projectId,
            this.universe.hasProvider(rsglGeneratedProviderId) ? "lspFailed" : "runtimeLoadFailed",
            causeId
          );
        }
      }
    }
    if (!this.universe.hasProvider(rsglGeneratedProviderId)) {
      return "unavailable";
    }
    const current = this.universe.getCoverage(rsglGeneratedProviderId, projectId);
    const shouldRefresh = shouldRequestGeneratedSnapshot(current);
    if (shouldRefresh && !requestedLazyRegistration && this.generatedProjectRefresher) {
      try {
        await this.generatedProjectRefresher(projectId, signal, causeId);
      } catch (error) {
        if (!isAbortError(error) && !signal?.aborted) {
          this.invalidateProviderProject("rsgl", projectId, "lspFailed", causeId);
        }
      }
    }
    return visibleCoverage(this.universe.getCoverage(rsglGeneratedProviderId, projectId));
  }

  private invalidateProviderProject(
    providerId: string,
    projectId: string,
    reason: ResourceProviderUnavailableReason,
    causeId: symbol | undefined
  ): void {
    if (causeId) {
      this.universe.invalidateProviderProject(providerId, projectId, reason, causeId);
    } else {
      this.universe.invalidateProviderProject(providerId, projectId, reason);
    }
  }

  private async ensureProducerProject(
    producer: ResourceProducer,
    options: UnifiedResourceQueryOptions
  ): Promise<EnsuredResourceProject> {
    const context = this.projects.getCachedContext(producer.projectId);
    const anchor = context?.projectRootUri
      ?? producer.sourceOrigins[0]?.uri
      ?? producer.physicalOrigins[0]?.uri;
    return anchor
      ? this.ensureProjectForUri(vscode.Uri.parse(anchor, true), options)
      : {
          context,
          coverage: "unavailable",
          rsglApplicability: this.projects.getRsglApplicability(producer.projectId)
        };
  }

  private applicableProviderIds(
    includeGenerated: boolean,
    projectId?: string,
    discoveredApplicability?: RsglProjectApplicability
  ): string[] {
    const applicability = discoveredApplicability
      ?? (projectId === undefined ? undefined : this.projects.getRsglApplicability(projectId));
    const generatedApplicable = includeGenerated
      && applicability !== "none";
    return [physicalProviderId, ...(generatedApplicable ? [rsglGeneratedProviderId] : [])];
  }

  private tryResolveLegacyReference(
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

  private findPhysicalProducer(
    target: ResourceGraphLogicalKey,
    projectId: string,
    winner: vscode.Uri
  ): ResourceProducer | undefined {
    const winnerIdentity = resourceUriComparisonIdentity(winner.toString());
    return this.universe.getProducersForKey(target).find(producer =>
      producer.projectId === projectId
      && producer.providerId === physicalProviderId
      && producer.physicalOrigins.some(origin => resourceUriComparisonIdentity(origin.uri) === winnerIdentity)
    );
  }

  private referenceForEdge(edge: ResourceEdge): ResourceReference | null {
    if (edge.sourceReference && isResourceReferenceKind(edge.sourceReference.kind)) {
      return {
        ...edge.sourceReference,
        kind: edge.sourceReference.kind,
        valueNode: {},
        relationship: edge.relationship === "modelParent" ? "modelParent" : undefined
      };
    }
    const kind = referenceKindForLogicalKind(edge.target.kind);
    if (!kind) {
      return null;
    }
    const target = minecraftResourceTarget(edge.target.kind);
    return {
      value: edge.target.id,
      valueNode: {},
      target: target.directory,
      source: "assets",
      extension: target.extension,
      kind,
      relationship: edge.relationship === "modelParent" ? "modelParent" : undefined
    };
  }

  private sourceUriForEdge(edge: ResourceEdge): vscode.Uri | null {
    const producer = this.universe.getProducer(edge.sourceProducerId);
    const uri = edge.sourceLocation?.uri
      ?? producer?.sourceOrigins[0]?.uri
      ?? producer?.physicalOrigins[0]?.uri;
    return uri ? vscode.Uri.parse(uri, true) : null;
  }
}

function isGeneratedResourceDocument(document: ResourceUniverseDocument): boolean {
  return isRsglDocument(document);
}

function resolutionContext(
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
  const winner = resolution.winner;
  if (!winner) {
    return "miss";
  }
  try {
    return isResourceProjectUriWithin(winner.toString(), context.localLayer.rootUri)
      ? "localWinner"
      : "otherWinner";
  } catch {
    return "otherWinner";
  }
}

function visibleCoverage(coverage: ProviderCoverage | undefined): UnifiedResourceCoverage {
  if (!coverage || coverage.status === "unavailable") {
    return "unavailable";
  }
  return coverage.status === "partial" ? "partial" : "authoritative";
}

function referenceKindForLogicalKind(kind: string): ResourceReference["kind"] | null {
  const collapsed = minecraftReferenceKindForResourceKind(kind);
  return collapsed !== null && isResourceReferenceKind(collapsed) ? collapsed : null;
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

function projectNavigationResources(
  target: ResourceGraphLogicalKey,
  navigation: ResourceNavigationResult
): UnifiedResourceProducerTarget[] {
  const candidates = navigation.status === "resolved"
    ? [navigation.producer]
    : navigation.status === "missing" || navigation.status === "incomplete"
      ? navigation.candidates
      : navigation.candidates;
  return candidates.map(producer => ({
    target,
    producer,
    candidates,
    resolutionStatus: navigation.status
  }));
}

function uniqueProducerTargets(
  resources: readonly UnifiedResourceProducerTarget[]
): UnifiedResourceProducerTarget[] {
  return [...new Map(resources.map(resource => [
    `${resource.target.kind}\0${resource.target.id}\0${resource.producer.producerId}`,
    resource
  ])).values()].sort((left, right) =>
    left.target.id.localeCompare(right.target.id, "en")
    || left.producer.producerId.localeCompare(right.producer.producerId, "en")
  );
}

function uniqueResolvedReferences(
  references: readonly UnifiedResolvedReference[]
): UnifiedResolvedReference[] {
  return [...new Map(references.map(reference => [
    [
      reference.sourceProducer?.producerId ?? reference.sourceUri.toString(),
      reference.sourceRange?.start ?? "",
      reference.sourceRange?.end ?? "",
      reference.target?.kind ?? "",
      reference.target?.id ?? ""
    ].join("\0"),
    reference
  ])).values()];
}

function uniqueResourceLocations(locations: readonly ResourceLocation[]): ResourceLocation[] {
  return [...new Map(locations.map(location => [[
    resourceUriComparisonIdentity(location.uri),
    location.range?.start ?? "",
    location.range?.end ?? "",
    location.origin
  ].join("\0"), location])).values()];
}
