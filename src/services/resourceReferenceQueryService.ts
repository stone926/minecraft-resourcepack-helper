import * as vscode from "vscode";
import {
  canonicalizeResourceGraphIdentity,
  canonicalizeResourceGraphOutputPath,
  uniqueLogicalKeys
} from "../../packages/mc-assets/src";
import type { ResourceProducer } from "../resourceUniverse/core/types";
import type { ResourceUniverseService } from "../resourceUniverse/core/resourceUniverseService";
import type {
  ResourceNavigationResult,
  ResourceNavigationService
} from "../resourceUniverse/navigation/resourceNavigationService";
import { getResourceReferences, type ResourceReference } from "../utils/resourceReferences";
import {
  resourceReferenceForEdge,
  resourceSourceUriForEdge
} from "./resourceEdgeReferenceMapper";
import { combineResourceFactsCoverage as combineCoverage } from "./resourceFactsCoverage";
import { createResourceResolutionContext } from "./resourceNavigationContext";
import type { LegacyReferenceBridge } from "./legacyReferenceBridge";
import type { ProjectRefreshCoordinator } from "./projectRefreshCoordinator";
import type {
  ResourceUniverseDocument,
  UnifiedReferenceResolution,
  UnifiedReferenceSet,
  UnifiedResolvedReference,
  UnifiedResourceQueryOptions
} from "./resourceUniverseNavigation";

/** Resource-reference extraction and indexed incoming/outgoing query orchestration. */
export class ResourceReferenceQueryService {
  public constructor(
    private readonly universe: ResourceUniverseService,
    private readonly navigation: ResourceNavigationService,
    private readonly refreshCoordinator: ProjectRefreshCoordinator,
    private readonly legacy: LegacyReferenceBridge
  ) {}

  public async resolveReference(
    document: ResourceUniverseDocument,
    reference: ResourceReference,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<UnifiedReferenceResolution> {
    if (reference.value.startsWith("#")) {
      return { targetUri: null, coverage: "authoritative" };
    }

    const legacy = this.legacy.resolve(document, reference);
    const identity = canonicalizeResourceGraphIdentity(reference.kind, reference.value, {
      extension: reference.extension
    });
    const discovered = await this.refreshCoordinator.discoverProjectForUri(document.uri);
    if (discovered.context && !this.legacy.requiresIndexRefresh(
      document,
      discovered.context,
      discovered.rsglApplicability,
      legacy
    )) {
      return {
        target: identity?.primaryKey,
        targetUri: legacy.winner,
        coverage: "authoritative"
      };
    }

    const ensured = await this.refreshCoordinator.refreshDiscoveredProject(discovered, options);
    return this.legacy.resolveIndexedReference(
      document,
      identity?.primaryKey,
      legacy.winner,
      ensured,
      options,
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
      const legacyWinner = this.legacy.resolve(document, reference).winner;
      const identity = canonicalizeResourceGraphIdentity(reference.kind, reference.value, {
        extension: reference.extension
      });
      return {
        reference,
        resolution: this.legacy.resolveIndexedReference(
          document,
          identity?.primaryKey,
          legacyWinner,
          ensured,
          options,
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
