import type { ResourceGraphLogicalKey } from "../../../packages/mc-assets/src";

export type ResourceResolutionScope = "effective" | "local" | "custom" | "vanilla";
export type ResourceLayerRole = "local" | "custom" | "vanilla";
export type ResourceProducerOrigin = "physical" | "generated" | "materialized";
export type ResourceMaterializationState =
  | "unbuilt"
  | "current"
  | "stale"
  | "conflict"
  | "handwritten";

export interface ResourceTextRange {
  start: number;
  end: number;
}

export interface ResourceLocation {
  uri: string;
  range?: ResourceTextRange;
  editable?: boolean;
  origin: ResourceProducerOrigin;
}

export interface ResourceProducer {
  producerId: string;
  providerId: string;
  projectId: string;
  layerId: string;
  layerRole: ResourceLayerRole;
  origin: Exclude<ResourceProducerOrigin, "materialized">;
  logicalKeys: readonly ResourceGraphLogicalKey[];
  aliasKeys?: readonly ResourceGraphLogicalKey[];
  aggregateMemberships?: readonly ResourceGraphLogicalKey[];
  sourceOrigins: readonly ResourceLocation[];
  physicalOrigins: readonly ResourceLocation[];
  materializationState: ResourceMaterializationState;
  outputPath?: string;
  /** Higher-priority layers whose pack filters exclude this producer from an effective stack. */
  blockedByLayerIds?: readonly string[];
  revision: string;
}

export interface ResourceEdge {
  edgeId: string;
  providerId: string;
  projectId: string;
  sourceProducerId: string;
  target: ResourceGraphLogicalKey;
  resolutionScope: ResourceResolutionScope;
  resolutionContextId: string;
  sourceLocation?: ResourceLocation;
  sourceGeneratedPath?: string;
  relationship?: string;
  origin: "direct" | "inherited";
  sourceReference?: ResourceEdgeSourceReference;
}

/** Lossless physical-extractor evidence used by graph/navigation adapters. */
export interface ResourceEdgeSourceReference {
  value: string;
  target: string;
  source: string;
  extension: string | null;
  kind: string;
}

export interface ResourceCoverageScope {
  projectId: string;
  resolutionScopes?: readonly ResourceResolutionScope[];
  kinds?: readonly string[];
  namespaces?: readonly string[];
  pathPrefixes?: readonly string[];
}

export type ResourceProviderUnavailableReason =
  | "notProbed"
  | "disabled"
  | "loading"
  | "runtimeLoadFailed"
  | "lspStarting"
  | "lspFailed"
  | "protocolMismatch"
  | "stale";

export type ProviderCoverage =
  | { status: "notApplicable"; reason: "noRsglProject" | "outOfScope" }
  | {
      status: "authoritative";
      revision: string;
      coveredScope: ResourceCoverageScope;
    }
  | {
      status: "partial";
      revision: string;
      authoritativeScopes: readonly ResourceCoverageScope[];
      unavailableScopes: readonly ResourceCoverageScope[];
      skippedSourceUris: readonly string[];
    }
  | {
      status: "unavailable";
      reason: ResourceProviderUnavailableReason;
      lastKnownRevision?: string;
    };

export interface ResourceProviderSnapshot {
  providerId: string;
  projectId: string;
  generation: number;
  revision?: string;
  coverage: ProviderCoverage;
  producers: readonly ResourceProducer[];
  edges: readonly ResourceEdge[];
}

export interface ResourceContributionRequest {
  projectId: string;
  scope: ResourceCoverageScope;
  knownRevision?: string;
  requestGeneration: number;
}

/** VS Code-free document identity used by provider-specific UI projections. */
export interface ResourceDocumentDescriptor {
  uri: string;
  fileName: string;
  languageId: string;
}

export interface ResourceDocumentProjectionRequest {
  projectId: string;
  document: ResourceDocumentDescriptor;
  /** Current indexed facts owned by the provider for this project. */
  producers: readonly ResourceProducer[];
}

export interface ResourceDocumentProjection {
  providerId: string;
  projectId: string;
  documentUri: string;
  /** Concrete outputs primarily declared by this document. */
  resources: readonly ResourceProducer[];
  /** Concrete outputs whose template/import expansion also uses this document. */
  contributesTo: readonly ResourceProducer[];
}

export interface ResourceContributionProvider {
  readonly providerId: string;
  getSnapshot(
    request: ResourceContributionRequest,
    signal: AbortSignal
  ): Promise<ResourceProviderSnapshot>;
  /** Cheap, side-effect-free gate. It must never start a provider runtime. */
  canHandleDocument?(document: ResourceDocumentDescriptor): boolean;
  /** Projects already-indexed facts and must not parse, compile, or perform I/O. */
  getDocumentProjection?(
    request: ResourceDocumentProjectionRequest
  ): ResourceDocumentProjection;
}

export interface ResourceResolutionContext {
  contextId: string;
  projectId: string;
  scope: ResourceResolutionScope;
  /** Layer ids in effective winner order, highest priority first. */
  orderedLayerIds: readonly string[];
  /** Every provider that could contribute to this target and scope. */
  applicableProviderIds: readonly string[];
}

export interface ResourceResolvedCandidate {
  producer: ResourceProducer;
  matchedAs: "concrete" | "alias";
  layerPriority: number;
}

export type ResourceResolutionResult =
  | {
      status: "resolved";
      target: ResourceGraphLogicalKey;
      winner: ResourceProducer;
      candidates: readonly ResourceResolvedCandidate[];
      coverageComplete: boolean;
      unavailableProviderIds: readonly string[];
    }
  | {
      status: "conflict";
      target: ResourceGraphLogicalKey;
      candidates: readonly ResourceResolvedCandidate[];
      coverageComplete: boolean;
      unavailableProviderIds: readonly string[];
    }
  | {
      status: "missing";
      target: ResourceGraphLogicalKey;
      candidates: readonly [];
      coverageComplete: true;
      unavailableProviderIds: readonly [];
    }
  | {
      status: "incomplete";
      target: ResourceGraphLogicalKey;
      candidates: readonly ResourceResolvedCandidate[];
      coverageComplete: false;
      unavailableProviderIds: readonly string[];
    };
