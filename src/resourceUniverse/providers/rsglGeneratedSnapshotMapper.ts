import type {
  RsglProviderCoverageDto,
  RsglResourceEdgeDto,
  RsglResourceIssueDto,
  RsglResourceLocationDto,
  RsglResourceSnapshotResponse
} from "../../../packages/rsgl-shared/src/resourceSnapshotProtocol";
import { uniqueValues } from "../../../packages/mc-assets/src";
import { resourceUriComparisonIdentity } from "../core/resourceUriIdentity";
import type {
  ProviderCoverage,
  ResourceEdge,
  ResourceLocation,
  ResourceProducer,
  ResourceProviderSnapshot
} from "../core";
import type { RsglGeneratedMaterializationIndex } from "./rsglGeneratedMaterialization";

export interface RsglGeneratedSnapshotFacts {
  revision: string;
  resources: NonNullable<RsglResourceSnapshotResponse["resources"]>;
  edges: NonNullable<RsglResourceSnapshotResponse["edges"]>;
  authoritative: boolean;
}

export interface RsglGeneratedSnapshotMappingOptions {
  providerId: string;
  projectId: string;
  generation: number;
  localLayerId: string;
  coverage: RsglProviderCoverageDto;
  facts: RsglGeneratedSnapshotFacts;
  materializations: RsglGeneratedMaterializationIndex;
}

export function createRsglGeneratedProviderSnapshot(
  options: RsglGeneratedSnapshotMappingOptions
): ResourceProviderSnapshot {
  const producers = options.facts.resources.map(resource => {
    const materialization = options.materializations.project(
      options.projectId,
      resource.producerId,
      resource.outputPath,
      resource.revision
    );
    return {
      producerId: resource.producerId,
      providerId: options.providerId,
      projectId: options.projectId,
      layerId: options.localLayerId,
      layerRole: "local",
      origin: "generated",
      logicalKeys: resource.logicalKeys.map(copyLogicalKey),
      aliasKeys: resource.aliasKeys?.map(copyLogicalKey) ?? [],
      aggregateMemberships: resource.aggregateMemberships?.map(copyLogicalKey) ?? [],
      sourceOrigins: uniqueLocations(resource.sourceOrigins.map(mapGeneratedLocation)),
      physicalOrigins: uniqueLocations(materialization?.locations ?? []),
      materializationState: materialization?.state ?? "unbuilt",
      outputPath: resource.outputPath,
      revision: resource.revision
    } satisfies ResourceProducer;
  }).sort((left, right) => left.producerId.localeCompare(right.producerId, "en"));
  assertUnique(producers, producer => producer.producerId, "producer");

  const producerIds = new Set(producers.map(producer => producer.producerId));
  const edges = options.facts.edges.map(edge => mapEdge(
    edge,
    options.providerId,
    options.projectId
  )).sort((left, right) => left.edgeId.localeCompare(right.edgeId, "en"));
  assertUnique(edges, edge => edge.edgeId, "edge");
  for (const edge of edges) {
    if (!producerIds.has(edge.sourceProducerId)) {
      throw new Error(`RSGL edge '${edge.edgeId}' references unknown producer '${edge.sourceProducerId}'.`);
    }
  }

  return {
    providerId: options.providerId,
    projectId: options.projectId,
    generation: options.generation,
    revision: options.facts.revision,
    coverage: mapCoverage(options.coverage),
    producers,
    edges
  };
}

export function mapRsglCoverage(coverage: RsglProviderCoverageDto): ProviderCoverage {
  return mapCoverage(coverage);
}

export function createRsglSnapshotFacts(
  response: RsglResourceSnapshotResponse
): RsglGeneratedSnapshotFacts {
  return {
    revision: response.revision!,
    resources: cloneResources(response.resources!),
    edges: cloneEdges(response.edges!),
    authoritative: response.status === "ok"
  };
}

/** Partial facts replace matching identities while retaining unavailable-scope siblings. */
export function mergeRsglSnapshotFacts(
  previous: RsglGeneratedSnapshotFacts,
  incoming: RsglGeneratedSnapshotFacts
): RsglGeneratedSnapshotFacts {
  return {
    revision: incoming.revision,
    resources: mergeByIdentity(previous.resources, incoming.resources, resource => resource.producerId),
    edges: mergeByIdentity(previous.edges, incoming.edges, edge => edge.edgeId),
    authoritative: false
  };
}

export function rsglCoverageBelongsToProject(
  coverage: RsglProviderCoverageDto,
  projectId: string
): boolean {
  if (coverage.status === "authoritative") {
    return coverage.coveredScope.projectId === projectId;
  }
  if (coverage.status === "partial") {
    return [...coverage.authoritativeScopes, ...coverage.unavailableScopes]
      .every(scope => scope.projectId === projectId);
  }
  return true;
}

export function cloneRsglResourceIssues(
  issues: readonly RsglResourceIssueDto[]
): RsglResourceIssueDto[] {
  return issues.map(issue => ({
    ...issue,
    ...(issue.location ? { location: cloneLocation(issue.location) } : {})
  }));
}

export function cloneProviderCoverage(coverage: ProviderCoverage): ProviderCoverage {
  if (coverage.status === "notApplicable" || coverage.status === "unavailable") {
    return { ...coverage };
  }
  if (coverage.status === "authoritative") {
    return {
      ...coverage,
      coveredScope: cloneScope(coverage.coveredScope)
    };
  }
  return {
    ...coverage,
    authoritativeScopes: coverage.authoritativeScopes.map(cloneScope),
    unavailableScopes: coverage.unavailableScopes.map(cloneScope),
    skippedSourceUris: [...coverage.skippedSourceUris]
  };
}

export function uniqueRsglStrings(values: readonly string[]): string[] {
  return uniqueValues(values).sort((left, right) => left.localeCompare(right, "en"));
}

function mapEdge(edge: RsglResourceEdgeDto, providerId: string, projectId: string): ResourceEdge {
  return {
    edgeId: edge.edgeId,
    providerId,
    projectId,
    sourceProducerId: edge.sourceProducerId,
    target: copyLogicalKey(edge.target),
    resolutionScope: edge.resolutionScope,
    resolutionContextId: edge.resolutionContextId,
    sourceLocation: mapGeneratedLocation(edge.sourceLocation),
    ...(edge.sourceGeneratedPath ? { sourceGeneratedPath: edge.sourceGeneratedPath } : {}),
    ...(edge.relationship ? { relationship: edge.relationship } : {}),
    origin: edge.origin
  };
}

function mapGeneratedLocation(location: RsglResourceLocationDto): ResourceLocation {
  return {
    uri: location.uri,
    ...(location.range ? { range: { start: location.range.start, end: location.range.end } } : {}),
    editable: isEditableUri(location.uri),
    origin: "generated"
  };
}

function mapCoverage(coverage: RsglProviderCoverageDto): ProviderCoverage {
  if (coverage.status === "notApplicable") {
    return { status: "notApplicable", reason: coverage.reason };
  }
  if (coverage.status === "unavailable") {
    return {
      status: "unavailable",
      reason: coverage.reason,
      ...(coverage.lastKnownRevision ? { lastKnownRevision: coverage.lastKnownRevision } : {})
    };
  }
  if (coverage.status === "authoritative") {
    return {
      status: "authoritative",
      revision: coverage.revision,
      coveredScope: cloneScope(coverage.coveredScope)
    };
  }
  return {
    status: "partial",
    revision: coverage.revision,
    authoritativeScopes: coverage.authoritativeScopes.map(cloneScope),
    unavailableScopes: coverage.unavailableScopes.map(cloneScope),
    skippedSourceUris: [...coverage.skippedSourceUris]
  };
}

function copyLogicalKey(key: { kind: string; id: string }) {
  return { kind: key.kind, id: key.id };
}

function uniqueLocations(locations: readonly ResourceLocation[]): ResourceLocation[] {
  return [...new Map(locations.map(location => [
    `${resourceUriComparisonIdentity(location.uri)}\0${location.range?.start ?? ""}\0${location.range?.end ?? ""}`,
    location
  ])).values()];
}

function assertUnique<T>(values: readonly T[], identity: (value: T) => string, label: string): void {
  const identities = new Set<string>();
  for (const value of values) {
    const key = identity(value);
    if (identities.has(key)) {
      throw new Error(`Duplicate RSGL ${label} '${key}'.`);
    }
    identities.add(key);
  }
}

function mergeByIdentity<T>(
  previous: readonly T[],
  incoming: readonly T[],
  identity: (value: T) => string
): T[] {
  return [...new Map([...previous, ...incoming].map(value => [identity(value), value])).values()];
}

function cloneResources(
  resources: NonNullable<RsglResourceSnapshotResponse["resources"]>
): NonNullable<RsglResourceSnapshotResponse["resources"]> {
  return structuredClone(resources);
}

function cloneEdges(edges: readonly RsglResourceEdgeDto[]): RsglResourceEdgeDto[] {
  return structuredClone(edges) as RsglResourceEdgeDto[];
}

function cloneLocation<T extends {
  uri: string;
  range?: { start: number; end: number };
}>(location: T): T {
  return structuredClone(location);
}

function cloneScope<T extends {
  projectId: string;
  resolutionScopes?: readonly string[];
  kinds?: readonly string[];
  namespaces?: readonly string[];
  pathPrefixes?: readonly string[];
}>(scope: T): T {
  return {
    ...scope,
    ...(scope.resolutionScopes ? { resolutionScopes: [...scope.resolutionScopes] } : {}),
    ...(scope.kinds ? { kinds: [...scope.kinds] } : {}),
    ...(scope.namespaces ? { namespaces: [...scope.namespaces] } : {}),
    ...(scope.pathPrefixes ? { pathPrefixes: [...scope.pathPrefixes] } : {})
  };
}

function isEditableUri(uri: string): boolean {
  return uri.startsWith("file:") || uri.startsWith("vscode-remote:");
}
