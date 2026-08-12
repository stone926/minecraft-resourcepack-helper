import type * as vscode from "vscode";
import type { ResourceGraphLogicalKey } from "../../packages/mc-assets/src";
import type { ResourcePackProjectContextDto } from "../../packages/resource-project/src";
import type { RsglProjectApplicability } from "../resourceProject";
import type {
  ResourceDocumentProjection,
  ResourceLocation,
  ResourceProducer,
  ResourceResolutionScope
} from "../resourceUniverse/core/types";
import type { ResourceUniverseChangeEvent } from "../resourceUniverse/core/resourceUniverseService";
import type {
  ResourceNavigationOptions,
  ResourceNavigationResult
} from "../resourceUniverse/navigation/resourceNavigationService";
import type {
  ResourceReference,
  ResourceReferenceDocument
} from "../utils/resourceReferences";
import type {
  ProviderFactsCoverage,
  ResourceFactsCoverage
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

export interface UnifiedResourceInventory {
  resources: readonly UnifiedResourceProducerTarget[];
  coverage: UnifiedResourceCoverage;
  /** Projects whose indexed facts were considered; empty means discovery still needs an anchor. */
  projectIds?: readonly string[];
}

export interface UnifiedResourceInventoryOptions {
  signal?: AbortSignal;
  /** Restricts inventory to projects explicitly discovered for this consumer. */
  projectIds?: readonly string[];
  /** Selects logical targets from only local producers or from the complete effective stack. */
  layerScope?: "local" | "effective";
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

/** Public structural navigation contract consumed by extension surfaces. */
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
  /** Rebinds a selected producer without triggering discovery or refresh work. */
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
