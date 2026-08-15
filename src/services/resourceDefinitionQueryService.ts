import * as vscode from "vscode";
import {
  canonicalizeResourceGraphOutputPath,
  type ResourceGraphLogicalKey
} from "../../packages/mc-assets/src";
import { physicalProviderId, rsglGeneratedProviderId } from "../resourceUniverse/core/providerIds";
import { resourceUriComparisonIdentity } from "../resourceUniverse/core/resourceUriIdentity";
import type {
  ResourceLocation,
  ResourceResolutionScope
} from "../resourceUniverse/core/types";
import type { ResourceUniverseService } from "../resourceUniverse/core/resourceUniverseService";
import type { PhysicalAssetDefinitionResolver } from "../resourceUniverse/providers/physicalAssetDefinitionResolver";
import type {
  ResourceNavigationOptions,
  ResourceNavigationResult,
  ResourceNavigationService
} from "../resourceUniverse/navigation/resourceNavigationService";
import { isAbortError } from "../utils/abortError";
import { isRsglDocument } from "../rsgl/rsglActivationSignals";
import {
  combineResourceFactsCoverage as combineCoverage,
  summarizeDocumentProviderFacts
} from "./resourceFactsCoverage";
import { createResourceResolutionContext } from "./resourceNavigationContext";
import type { ProjectRefreshCoordinator } from "./projectRefreshCoordinator";
import type {
  ResourceUniverseDocument,
  UnifiedDocumentProjection,
  UnifiedLogicalDefinitionResolution,
  UnifiedLogicalReferenceLocations,
  UnifiedResourceQueryOptions
} from "./resourceUniverseNavigation";

/** Definition, document projection, and direct producer navigation queries. */
export class ResourceDefinitionQueryService {
  private physicalDefinitionResolver?: PhysicalAssetDefinitionResolver;

  public constructor(
    private readonly universe: ResourceUniverseService,
    private readonly navigation: ResourceNavigationService,
    private readonly refreshCoordinator: ProjectRefreshCoordinator
  ) {}

  public setPhysicalDefinitionResolver(resolver: PhysicalAssetDefinitionResolver): void {
    this.physicalDefinitionResolver = resolver;
  }

  public async resolveLogicalDefinition(
    sourceUri: vscode.Uri,
    target: ResourceGraphLogicalKey,
    scope: ResourceResolutionScope,
    options: Omit<UnifiedResourceQueryOptions, "includeGenerated"> = {}
  ): Promise<UnifiedLogicalDefinitionResolution> {
    const discovered = await this.refreshCoordinator.discoverProjectForUri(sourceUri);
    if (!discovered.context) {
      return { coverage: "unavailable" };
    }

    const currentCoverage = this.universe.getCoverage(
      physicalProviderId,
      discovered.context.projectId
    );
    const currentIndexIsUsable = this.refreshCoordinator.isPhysicalIndexCurrent(discovered.context)
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
            directLocations: [{ uri: exact.definition.uri, origin: "physical" }]
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
        // A bounded optimization failure falls through to the full provider path.
      }
    }

    const ensured = await this.refreshCoordinator.refreshDiscoveredProject(discovered, {
      ...options,
      includeGenerated: false
    });
    if (!ensured.context) {
      return { coverage: ensured.coverage };
    }
    return {
      context: ensured.context,
      coverage: ensured.coverage,
      navigation: this.navigation.resolveDefinition(
        target,
        createResourceResolutionContext(
          ensured.context,
          this.refreshCoordinator.applicableProviderIds(
            false,
            ensured.context.projectId
          ),
          scope
        ),
        { activeUri: sourceUri.toString() }
      )
    };
  }

  /** Returns only physical consumers; RSGL references already belong to LSP analysis. */
  public async getLogicalIncomingReferenceLocations(
    sourceUri: vscode.Uri,
    target: ResourceGraphLogicalKey,
    options: Omit<UnifiedResourceQueryOptions, "includeGenerated"> = {}
  ): Promise<UnifiedLogicalReferenceLocations> {
    const ensured = await this.refreshCoordinator.ensureProjectForUri(sourceUri, {
      ...options,
      includeGenerated: false
    });
    if (!ensured.context) {
      return { coverage: ensured.coverage, locations: [] };
    }
    const locations = this.universe.getIncoming(
      target,
      createResourceResolutionContext(ensured.context, [physicalProviderId])
    )
      .filter(edge =>
        edge.projectId === ensured.context!.projectId
        && edge.providerId === physicalProviderId)
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

  public async getDocumentProjection(
    document: ResourceUniverseDocument
  ): Promise<UnifiedDocumentProjection> {
    const descriptor = {
      uri: document.uri.toString(),
      fileName: document.fileName,
      languageId: document.languageId
    };
    const providerIds = this.universe.getDocumentProviderIds(descriptor);
    const generatedDocument = isRsglDocument(document);
    if (providerIds.length === 0 && !generatedDocument) {
      return {
        applicable: false,
        projections: [],
        coverage: "authoritative",
        providerCoverages: []
      };
    }

    const includeGenerated = generatedDocument || providerIds.includes(rsglGeneratedProviderId);
    const ensured = await this.refreshCoordinator.ensureProjectForUri(document.uri, {
      includeGenerated
    });
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

  public async resolveProducerNavigation(
    producerId: string,
    target: ResourceGraphLogicalKey,
    options: ResourceNavigationOptions & UnifiedResourceQueryOptions = {}
  ): Promise<ResourceNavigationResult | undefined> {
    const producer = this.universe.getProducer(producerId);
    if (!producer) {
      return undefined;
    }
    await this.refreshCoordinator.ensureProducerProject(producer, options);
    return this.navigation.resolveProducerDefinition(
      target,
      this.universe.getProducer(producerId) ?? producer,
      options
    );
  }

  public async resolveUriNavigation(
    uri: vscode.Uri,
    options: ResourceNavigationOptions & UnifiedResourceQueryOptions = {}
  ): Promise<ResourceNavigationResult | undefined> {
    const identity = canonicalizeResourceGraphOutputPath(
      uri.scheme === "file" ? uri.fsPath : uri.path,
      { fileSystemCaseSensitive: uri.scheme !== "file" }
    );
    const ensured = await this.refreshCoordinator.ensureProjectForUri(uri, options);
    if (!identity || !ensured.context) {
      return undefined;
    }
    return this.navigation.resolveDefinition(
      identity.primaryKey,
      createResourceResolutionContext(
        ensured.context,
        this.refreshCoordinator.applicableProviderIds(
          options.includeGenerated === true,
          ensured.context.projectId,
          ensured.rsglApplicability
        )
      ),
      options
    );
  }
}

function uniqueResourceLocations(locations: readonly ResourceLocation[]): ResourceLocation[] {
  return [...new Map(locations.map(location => [[
    resourceUriComparisonIdentity(location.uri),
    location.range?.start ?? "",
    location.range?.end ?? "",
    location.origin
  ].join("\0"), location])).values()];
}
