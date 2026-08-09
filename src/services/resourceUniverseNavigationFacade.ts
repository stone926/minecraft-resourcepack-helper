import * as vscode from "vscode";
import type { ResourceGraphLogicalKey } from "../../packages/mc-assets/src";
import type { ResourcePackProjectService } from "../resourceProject";
import type { ResourceResolutionScope } from "../resourceUniverse/core/types";
import type {
  ResourceUniverseChangeEvent,
  ResourceUniverseService
} from "../resourceUniverse/core/resourceUniverseService";
import type { PhysicalAssetDefinitionResolver } from "../resourceUniverse/providers/physicalAssetDefinitionResolver";
import {
  ResourceNavigationService,
  type ResourceNavigationOptions,
  type ResourceNavigationResult
} from "../resourceUniverse/navigation/resourceNavigationService";
import type { ResourceReference } from "../utils/resourceReferences";
import { ProjectRefreshCoordinator } from "./projectRefreshCoordinator";
import { ResourceDefinitionQueryService } from "./resourceDefinitionQueryService";
import { ResourceProjectUniverseInvalidator } from "./resourceProjectUniverseInvalidator";
import { ResourceReferenceQueryService } from "./resourceReferenceQueryService";
import { ResourceSearchInventoryService } from "./resourceSearchInventoryService";
import type {
  EnsuredResourceProject,
  GeneratedResourceProjectRefresher,
  ResourceUniverseDocument,
  ResourceUniverseNavigation,
  UnifiedDocumentProjection,
  UnifiedLogicalDefinitionResolution,
  UnifiedLogicalReferenceLocations,
  UnifiedReferenceResolution,
  UnifiedReferenceSet,
  UnifiedResourceInventory,
  UnifiedResourceInventoryOptions,
  UnifiedResourceProducerTarget,
  UnifiedResourceQueryOptions
} from "./resourceUniverseNavigation";

/** Thin composition root for the public ResourceUniverse navigation contract. */
export class ResourceUniverseNavigationFacade implements ResourceUniverseNavigation {
  private readonly refreshCoordinator: ProjectRefreshCoordinator;
  private readonly definitionQueries: ResourceDefinitionQueryService;
  private readonly referenceQueries: ResourceReferenceQueryService;
  private readonly inventory: ResourceSearchInventoryService;
  private readonly invalidator: ResourceProjectUniverseInvalidator;

  public constructor(
    projects: ResourcePackProjectService,
    private readonly universe: ResourceUniverseService
  ) {
    const navigation = new ResourceNavigationService(universe.index);
    this.refreshCoordinator = new ProjectRefreshCoordinator(projects, universe);
    this.definitionQueries = new ResourceDefinitionQueryService(
      universe,
      navigation,
      this.refreshCoordinator
    );
    this.referenceQueries = new ResourceReferenceQueryService(
      universe,
      navigation,
      this.refreshCoordinator
    );
    this.inventory = new ResourceSearchInventoryService(
      projects,
      universe,
      navigation,
      this.refreshCoordinator
    );
    this.invalidator = new ResourceProjectUniverseInvalidator(projects, universe);
  }

  public setGeneratedProjectRefresher(refresher: GeneratedResourceProjectRefresher): void {
    this.refreshCoordinator.setGeneratedProjectRefresher(refresher);
  }

  public setPhysicalDefinitionResolver(resolver: PhysicalAssetDefinitionResolver): void {
    this.definitionQueries.setPhysicalDefinitionResolver(resolver);
    this.referenceQueries.setPhysicalDefinitionResolver(resolver);
  }

  public onDidChangeResources(
    listener: (event: ResourceUniverseChangeEvent) => void
  ): { dispose(): void } {
    return this.universe.onDidChange(listener);
  }

  public resolveReference(
    document: ResourceUniverseDocument,
    reference: ResourceReference,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<UnifiedReferenceResolution> {
    return this.referenceQueries.resolveReference(document, reference, options);
  }

  public resolveLogicalDefinition(
    sourceUri: vscode.Uri,
    target: ResourceGraphLogicalKey,
    scope: ResourceResolutionScope,
    options: Omit<UnifiedResourceQueryOptions, "includeGenerated"> = {}
  ): Promise<UnifiedLogicalDefinitionResolution> {
    return this.definitionQueries.resolveLogicalDefinition(sourceUri, target, scope, options);
  }

  public getLogicalIncomingReferenceLocations(
    sourceUri: vscode.Uri,
    target: ResourceGraphLogicalKey,
    options: Omit<UnifiedResourceQueryOptions, "includeGenerated"> = {}
  ): Promise<UnifiedLogicalReferenceLocations> {
    return this.definitionQueries.getLogicalIncomingReferenceLocations(sourceUri, target, options);
  }

  public getOutgoingReferences(
    document: ResourceUniverseDocument,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<UnifiedReferenceSet> {
    return this.referenceQueries.getOutgoingReferences(document, options);
  }

  public getIncomingReferences(
    uri: vscode.Uri,
    relationship?: string,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<UnifiedReferenceSet> {
    return this.referenceQueries.getIncomingReferences(uri, relationship, options);
  }

  public ensureProjectForUri(
    uri: vscode.Uri,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<EnsuredResourceProject> {
    return this.refreshCoordinator.ensureProjectForUri(uri, options);
  }

  public getDocumentProjection(
    document: ResourceUniverseDocument
  ): Promise<UnifiedDocumentProjection> {
    return this.definitionQueries.getDocumentProjection(document);
  }

  public getKnownResources(
    kinds: readonly string[],
    options: UnifiedResourceInventoryOptions = {}
  ): Promise<UnifiedResourceInventory> {
    return this.inventory.getKnownResources(kinds, options);
  }

  public getKnownResource(
    producerId: string,
    target: ResourceGraphLogicalKey
  ): UnifiedResourceProducerTarget | undefined {
    return this.inventory.getKnownResource(producerId, target);
  }

  public getProducerOutgoingReferences(
    producerId: string,
    options: UnifiedResourceQueryOptions = { includeGenerated: true }
  ): Promise<UnifiedReferenceSet> {
    return this.referenceQueries.getProducerOutgoingReferences(producerId, options);
  }

  public getProducerIncomingReferences(
    producerId: string,
    relationship?: string,
    options: UnifiedResourceQueryOptions = { includeGenerated: true }
  ): Promise<UnifiedReferenceSet> {
    return this.referenceQueries.getProducerIncomingReferences(
      producerId,
      relationship,
      options
    );
  }

  public resolveProducerNavigation(
    producerId: string,
    target: ResourceGraphLogicalKey,
    options: ResourceNavigationOptions & UnifiedResourceQueryOptions = {}
  ): Promise<ResourceNavigationResult | undefined> {
    return this.definitionQueries.resolveProducerNavigation(producerId, target, options);
  }

  public resolveUriNavigation(
    uri: vscode.Uri,
    options: ResourceNavigationOptions & UnifiedResourceQueryOptions = {}
  ): Promise<ResourceNavigationResult | undefined> {
    return this.definitionQueries.resolveUriNavigation(uri, options);
  }

  public invalidateUri(uri: vscode.Uri): readonly string[] {
    return this.invalidator.invalidatePhysicalUri(uri.toString());
  }

  public invalidateAllKnownProjects(): void {
    this.invalidator.invalidateAllKnownProjects();
  }
}
