import {
  logicalKeyIdentity,
  uniqueValues,
  type ResourceGraphLogicalKey
} from "../../../packages/mc-assets/src";
import { projectProviderCoverage } from "./providerCoverage";
import type {
  ProviderCoverage,
  ResourceEdge,
  ResourceProducer,
  ResourceProviderSnapshot,
  ResourceResolutionContext,
  ResourceResolutionResult,
  ResourceResolvedCandidate
} from "./types";

interface StoredSnapshot {
  generation: number;
  revision?: string;
  coverage: ProviderCoverage;
  producerIds: readonly string[];
  edgeIds: readonly string[];
}

export class ResourceUniverseIndex {
  private readonly snapshots = new Map<string, StoredSnapshot>();
  private readonly producers = new Map<string, ResourceProducer>();
  private readonly edges = new Map<string, ResourceEdge>();
  private readonly concreteByKey = new Map<string, Set<string>>();
  private readonly aliasByKey = new Map<string, Set<string>>();
  private readonly aggregateByKey = new Map<string, Set<string>>();
  private readonly outgoingByProducer = new Map<string, Set<string>>();
  private readonly incomingByTarget = new Map<string, Set<string>>();

  /** Atomically replaces one provider's contribution for one project. */
  public replaceSnapshot(snapshot: ResourceProviderSnapshot): boolean {
    return this.replaceSnapshotsAtomically([snapshot]);
  }

  /**
   * Validates an entire provider batch before mutating any index. This keeps a
   * project refresh all-or-nothing when one provider returns malformed facts.
   */
  public replaceSnapshotsAtomically(snapshots: readonly ResourceProviderSnapshot[]): boolean {
    if (snapshots.length === 0) {
      return true;
    }

    const replacements = new Map<string, {
      current: StoredSnapshot | undefined;
      snapshot: ResourceProviderSnapshot;
    }>();
    for (const snapshot of snapshots) {
      const key = providerProjectKey(snapshot.providerId, snapshot.projectId);
      if (replacements.has(key)) {
        throw new Error(`Duplicate provider/project snapshot '${snapshot.providerId}/${snapshot.projectId}'.`);
      }
      const current = this.snapshots.get(key);
      if (current && snapshot.generation < current.generation) {
        return false;
      }
      const effectiveSnapshot = this.snapshotWithLastKnownFacts(snapshot, current);
      validateSnapshot(effectiveSnapshot);
      replacements.set(key, { current, snapshot: effectiveSnapshot });
    }

    this.validateBatchIdentityOwnership(replacements);
    for (const replacement of replacements.values()) {
      this.removeSnapshotContributions(replacement.current);
    }
    for (const [key, replacement] of replacements) {
      for (const producer of replacement.snapshot.producers) {
        this.addProducer(producer);
      }
      for (const edge of replacement.snapshot.edges) {
        this.addEdge(edge);
      }
      this.snapshots.set(key, {
        generation: replacement.snapshot.generation,
        revision: replacement.snapshot.revision,
        coverage: replacement.snapshot.coverage,
        producerIds: replacement.snapshot.producers.map(producer => producer.producerId),
        edgeIds: replacement.snapshot.edges.map(edge => edge.edgeId)
      });
    }
    return true;
  }

  public removeProviderProject(providerId: string, projectId: string): void {
    const snapshotKey = providerProjectKey(providerId, projectId);
    const current = this.snapshots.get(snapshotKey);
    this.removeSnapshotContributions(current);
    this.snapshots.delete(snapshotKey);
  }

  public getProducer(producerId: string): ResourceProducer | undefined {
    return this.producers.get(producerId);
  }

  public getCoverage(providerId: string, projectId: string): ProviderCoverage | undefined {
    return this.snapshots.get(providerProjectKey(providerId, projectId))?.coverage;
  }

  public getSnapshotRevision(providerId: string, projectId: string): string | undefined {
    return this.snapshots.get(providerProjectKey(providerId, projectId))?.revision;
  }

  public getSnapshotGeneration(providerId: string, projectId: string): number | undefined {
    return this.snapshots.get(providerProjectKey(providerId, projectId))?.generation;
  }

  public getProducersForKey(target: ResourceGraphLogicalKey): ResourceProducer[] {
    return this.producerIdsForKey(target)
      .map(producerId => this.producers.get(producerId))
      .filter((producer): producer is ResourceProducer => producer !== undefined);
  }

  public getProviderProjectProducers(providerId: string, projectId: string): ResourceProducer[] {
    const snapshot = this.snapshots.get(providerProjectKey(providerId, projectId));
    return (snapshot?.producerIds ?? [])
      .map(producerId => this.producers.get(producerId))
      .filter((producer): producer is ResourceProducer => producer !== undefined)
      .sort(compareProducers);
  }

  public getProjectProducers(projectId: string): ResourceProducer[] {
    return [...this.producers.values()]
      .filter(producer => producer.projectId === projectId)
      .sort(compareProducers);
  }

  public getAggregateMembers(target: ResourceGraphLogicalKey): ResourceProducer[] {
    return [...(this.aggregateByKey.get(logicalKeyIdentity(target)) ?? [])]
      .map(producerId => this.producers.get(producerId))
      .filter((producer): producer is ResourceProducer => producer !== undefined);
  }

  public getOutgoing(producerId: string): ResourceEdge[] {
    return [...(this.outgoingByProducer.get(producerId) ?? [])]
      .map(edgeId => this.edges.get(edgeId))
      .filter((edge): edge is ResourceEdge => edge !== undefined)
      .sort(compareEdges);
  }

  public getIncoming(target: ResourceGraphLogicalKey): ResourceEdge[] {
    return [...(this.incomingByTarget.get(logicalKeyIdentity(target)) ?? [])]
      .map(edgeId => this.edges.get(edgeId))
      .filter((edge): edge is ResourceEdge => edge !== undefined)
      .sort(compareEdges);
  }

  public resolve(
    target: ResourceGraphLogicalKey,
    context: ResourceResolutionContext
  ): ResourceResolutionResult {
    const candidates = this.candidatesFor(target, context);
    const unavailableProviderIds = context.applicableProviderIds
      .filter(providerId => projectProviderCoverage(
        this.getCoverage(providerId, context.projectId),
        context.projectId,
        context.scope,
        target
      ) === "unavailable")
      .sort(compareOrdinal);
    const coverageComplete = unavailableProviderIds.length === 0;

    if (candidates.length === 0) {
      return coverageComplete
        ? {
            status: "missing",
            target,
            candidates: [],
            coverageComplete: true,
            unavailableProviderIds: []
          }
        : {
            status: "incomplete",
            target,
            candidates: [],
            coverageComplete: false,
            unavailableProviderIds
          };
    }

    const highestPriority = candidates[0].layerPriority;
    const highest = candidates.filter(candidate => candidate.layerPriority === highestPriority);
    const outputPaths = new Set(highest.map(candidate => candidate.producer.outputPath).filter(Boolean));
    const hasPlannedPathCollision = highest.length > 1
      && outputPaths.size === 1
      && highest.every(candidate => candidate.producer.layerId === highest[0].producer.layerId);
    if (hasPlannedPathCollision) {
      return {
        status: "conflict",
        target,
        candidates,
        coverageComplete,
        unavailableProviderIds
      };
    }

    if (!coverageComplete) {
      return {
        status: "incomplete",
        target,
        candidates,
        coverageComplete: false,
        unavailableProviderIds
      };
    }
    return {
      status: "resolved",
      target,
      winner: highest[0].producer,
      candidates,
      coverageComplete: true,
      unavailableProviderIds: []
    };
  }

  private candidatesFor(
    target: ResourceGraphLogicalKey,
    context: ResourceResolutionContext
  ): ResourceResolvedCandidate[] {
    const priorities = new Map(context.orderedLayerIds.map((layerId, index) => [layerId, index]));
    const applicableProviderIds = new Set(context.applicableProviderIds);
    const result: ResourceResolvedCandidate[] = [];
    const concreteIds = this.concreteByKey.get(logicalKeyIdentity(target)) ?? new Set<string>();
    const aliasIds = this.aliasByKey.get(logicalKeyIdentity(target)) ?? new Set<string>();
    for (const producerId of new Set([...concreteIds, ...aliasIds])) {
      const producer = this.producers.get(producerId);
      if (!producer
        || producer.projectId !== context.projectId
        || !applicableProviderIds.has(producer.providerId)
        || !producerMatchesScope(producer, context.scope)) {
        continue;
      }
      const layerPriority = priorities.get(producer.layerId);
      if (layerPriority === undefined) {
        continue;
      }
      result.push({
        producer,
        matchedAs: concreteIds.has(producerId) ? "concrete" : "alias",
        layerPriority
      });
    }
    return result.sort((left, right) =>
      left.layerPriority - right.layerPriority
      || (left.matchedAs === "concrete" ? -1 : 1)
      || left.producer.producerId.localeCompare(right.producer.producerId, "en")
    );
  }

  private snapshotWithLastKnownFacts(
    snapshot: ResourceProviderSnapshot,
    current: StoredSnapshot | undefined
  ): ResourceProviderSnapshot {
    if (!current || snapshot.coverage.status === "authoritative" || snapshot.coverage.status === "notApplicable") {
      return snapshot;
    }

    const previousProducers = current.producerIds
      .map(producerId => this.producers.get(producerId))
      .filter((producer): producer is ResourceProducer => producer !== undefined);
    const previousEdges = current.edgeIds
      .map(edgeId => this.edges.get(edgeId))
      .filter((edge): edge is ResourceEdge => edge !== undefined);
    if (snapshot.coverage.status === "unavailable") {
      return {
        ...snapshot,
        producers: previousProducers,
        edges: previousEdges
      };
    }

    return {
      ...snapshot,
      producers: mergeByIdentity(previousProducers, snapshot.producers, producer => producer.producerId),
      edges: mergeByIdentity(previousEdges, snapshot.edges, edge => edge.edgeId)
    };
  }

  private validateBatchIdentityOwnership(
    replacements: ReadonlyMap<string, {
      current: StoredSnapshot | undefined;
      snapshot: ResourceProviderSnapshot;
    }>
  ): void {
    const replacedProducerIds = new Set<string>();
    const replacedEdgeIds = new Set<string>();
    for (const replacement of replacements.values()) {
      for (const producerId of replacement.current?.producerIds ?? []) {
        replacedProducerIds.add(producerId);
      }
      for (const edgeId of replacement.current?.edgeIds ?? []) {
        replacedEdgeIds.add(edgeId);
      }
    }

    const batchProducerIds = new Set<string>();
    const batchEdgeIds = new Set<string>();
    for (const replacement of replacements.values()) {
      for (const producer of replacement.snapshot.producers) {
        if (batchProducerIds.has(producer.producerId)
          || (this.producers.has(producer.producerId) && !replacedProducerIds.has(producer.producerId))) {
          throw new Error(`Duplicate resource producer '${producer.producerId}'.`);
        }
        batchProducerIds.add(producer.producerId);
      }
      for (const edge of replacement.snapshot.edges) {
        if (batchEdgeIds.has(edge.edgeId)
          || (this.edges.has(edge.edgeId) && !replacedEdgeIds.has(edge.edgeId))) {
          throw new Error(`Duplicate resource edge '${edge.edgeId}'.`);
        }
        batchEdgeIds.add(edge.edgeId);
      }
    }
  }

  private producerIdsForKey(target: ResourceGraphLogicalKey): string[] {
    const key = logicalKeyIdentity(target);
    return uniqueValues([
      ...(this.concreteByKey.get(key) ?? []),
      ...(this.aliasByKey.get(key) ?? [])
    ]).sort(compareOrdinal);
  }

  private addProducer(producer: ResourceProducer): void {
    if (this.producers.has(producer.producerId)) {
      throw new Error(`Duplicate resource producer '${producer.producerId}'.`);
    }
    this.producers.set(producer.producerId, producer);
    for (const key of producer.logicalKeys) {
      addIndexValue(this.concreteByKey, logicalKeyIdentity(key), producer.producerId);
    }
    for (const key of producer.aliasKeys ?? []) {
      addIndexValue(this.aliasByKey, logicalKeyIdentity(key), producer.producerId);
    }
    for (const key of producer.aggregateMemberships ?? []) {
      addIndexValue(this.aggregateByKey, logicalKeyIdentity(key), producer.producerId);
    }
  }

  private removeProducer(producerId: string): void {
    const producer = this.producers.get(producerId);
    if (!producer) {
      return;
    }
    for (const key of producer.logicalKeys) {
      removeIndexValue(this.concreteByKey, logicalKeyIdentity(key), producerId);
    }
    for (const key of producer.aliasKeys ?? []) {
      removeIndexValue(this.aliasByKey, logicalKeyIdentity(key), producerId);
    }
    for (const key of producer.aggregateMemberships ?? []) {
      removeIndexValue(this.aggregateByKey, logicalKeyIdentity(key), producerId);
    }
    this.producers.delete(producerId);
  }

  private addEdge(edge: ResourceEdge): void {
    if (this.edges.has(edge.edgeId)) {
      throw new Error(`Duplicate resource edge '${edge.edgeId}'.`);
    }
    this.edges.set(edge.edgeId, edge);
    addIndexValue(this.outgoingByProducer, edge.sourceProducerId, edge.edgeId);
    addIndexValue(this.incomingByTarget, logicalKeyIdentity(edge.target), edge.edgeId);
  }

  private removeEdge(edgeId: string): void {
    const edge = this.edges.get(edgeId);
    if (!edge) {
      return;
    }
    removeIndexValue(this.outgoingByProducer, edge.sourceProducerId, edgeId);
    removeIndexValue(this.incomingByTarget, logicalKeyIdentity(edge.target), edgeId);
    this.edges.delete(edgeId);
  }

  private removeSnapshotContributions(snapshot: StoredSnapshot | undefined): void {
    if (!snapshot) {
      return;
    }
    for (const edgeId of snapshot.edgeIds) {
      this.removeEdge(edgeId);
    }
    for (const producerId of snapshot.producerIds) {
      this.removeProducer(producerId);
    }
  }
}

function validateSnapshot(snapshot: ResourceProviderSnapshot): void {
  const producerIds = new Set<string>();
  for (const producer of snapshot.producers) {
    if (producer.providerId !== snapshot.providerId || producer.projectId !== snapshot.projectId) {
      throw new Error(`Producer '${producer.producerId}' does not belong to its provider snapshot.`);
    }
    if (producerIds.has(producer.producerId)) {
      throw new Error(`Duplicate resource producer '${producer.producerId}'.`);
    }
    producerIds.add(producer.producerId);
  }
  const edgeIds = new Set<string>();
  for (const edge of snapshot.edges) {
    if (edge.providerId !== snapshot.providerId || edge.projectId !== snapshot.projectId) {
      throw new Error(`Edge '${edge.edgeId}' does not belong to its provider snapshot.`);
    }
    if (edgeIds.has(edge.edgeId)) {
      throw new Error(`Duplicate resource edge '${edge.edgeId}'.`);
    }
    if (!producerIds.has(edge.sourceProducerId)) {
      throw new Error(`Edge '${edge.edgeId}' has unknown source producer '${edge.sourceProducerId}'.`);
    }
    edgeIds.add(edge.edgeId);
  }
}

function producerMatchesScope(producer: ResourceProducer, scope: ResourceResolutionContext["scope"]): boolean {
  if (scope === "local") {
    return producer.layerRole === "local"
      && producer.origin === "physical"
      && producer.materializationState === "handwritten";
  }
  if (scope === "custom") {
    return producer.layerRole === "custom";
  }
  if (scope === "vanilla") {
    return producer.layerRole === "vanilla";
  }
  return true;
}

function providerProjectKey(providerId: string, projectId: string): string {
  return `${providerId}\0${projectId}`;
}

function addIndexValue(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key);
  if (values) {
    values.add(value);
  } else {
    map.set(key, new Set([value]));
  }
}

function removeIndexValue(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key);
  if (!values) {
    return;
  }
  values.delete(value);
  if (values.size === 0) {
    map.delete(key);
  }
}

function compareEdges(left: ResourceEdge, right: ResourceEdge): number {
  return left.edgeId.localeCompare(right.edgeId, "en");
}

function compareOrdinal(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function compareProducers(left: ResourceProducer, right: ResourceProducer): number {
  return left.producerId.localeCompare(right.producerId, "en");
}

function mergeByIdentity<T>(
  previous: readonly T[],
  next: readonly T[],
  identity: (value: T) => string
): T[] {
  const merged = new Map(previous.map(value => [identity(value), value]));
  for (const value of next) {
    merged.set(identity(value), value);
  }
  return [...merged.values()].sort((left, right) =>
    identity(left).localeCompare(identity(right), "en")
  );
}
