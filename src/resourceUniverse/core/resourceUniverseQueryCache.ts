import { LruCache } from "../../../packages/shared-utils/src/lruCache";
import type {
  ResourceEdge,
  ResourceProducer,
  ResourceResolutionContext,
  ResourceResolvedCandidate
} from "./types";

const indexedQueryCacheSize = 8_192;
const projectQueryCacheSize = 512;
const resolutionPlanCacheSize = 32;
const resolutionFactsCacheSize = 8_192;

export interface ResourceUniverseResolutionPlan {
  cacheKey: string;
  projectId: string;
  scope: ResourceResolutionContext["scope"];
  layerPriorities: ReadonlyMap<string, number>;
  applicableProviderIds: ReadonlySet<string>;
  orderedProviderIds: readonly string[];
}

export interface ResourceUniverseResolutionFacts {
  candidates: readonly ResourceResolvedCandidate[];
  winner?: ResourceProducer;
  conflict: boolean;
  coverageComplete: boolean;
  unavailableProviderIds: readonly string[];
}

export interface ResourceUniverseQueryInvalidation {
  projectIds: Set<string>;
  providerProjectKeys: Set<string>;
  producerIds: Set<string>;
  logicalKeys: Set<string>;
  aggregateKeys: Set<string>;
  incomingTargets: Set<string>;
}

interface StoredResolutionFacts {
  planKey: string;
  facts: ResourceUniverseResolutionFacts;
}

/** Bounded derived-query state; canonical producers, edges, and snapshots remain in the index. */
export class ResourceUniverseQueryCache {
  private readonly producersForKey = new LruCache<string, readonly ResourceProducer[]>(indexedQueryCacheSize);
  private readonly aggregateMembers = new LruCache<string, readonly ResourceProducer[]>(indexedQueryCacheSize);
  private readonly outgoing = new LruCache<string, readonly ResourceEdge[]>(indexedQueryCacheSize);
  private readonly incoming = new LruCache<string, readonly ResourceEdge[]>(indexedQueryCacheSize);
  private readonly projectProducers = new LruCache<string, readonly ResourceProducer[]>(projectQueryCacheSize);
  private readonly providerProjectProducers = new LruCache<string, readonly ResourceProducer[]>(
    projectQueryCacheSize
  );
  private readonly planKeysByProject = new Map<string, Set<string>>();
  private readonly factKeysByPlan = new Map<string, Set<string>>();
  private readonly resolutionPlans: LruCache<string, ResourceUniverseResolutionPlan>;
  private readonly resolutionFacts: LruCache<string, StoredResolutionFacts>;

  public constructor() {
    this.resolutionFacts = new LruCache(resolutionFactsCacheSize, (factKey, stored) => {
      const keys = this.factKeysByPlan.get(stored.planKey);
      keys?.delete(factKey);
      if (keys?.size === 0) {
        this.factKeysByPlan.delete(stored.planKey);
      }
    });
    this.resolutionPlans = new LruCache(resolutionPlanCacheSize, (planKey, plan) => {
      const projectKeys = this.planKeysByProject.get(plan.projectId);
      projectKeys?.delete(planKey);
      if (projectKeys?.size === 0) {
        this.planKeysByProject.delete(plan.projectId);
      }
      for (const factKey of [...(this.factKeysByPlan.get(planKey) ?? [])]) {
        this.resolutionFacts.delete(factKey);
      }
      this.factKeysByPlan.delete(planKey);
    });
  }

  public getProducersForKey(key: string, load: () => ResourceProducer[]): ResourceProducer[] {
    return readList(this.producersForKey, key, load);
  }

  public getAggregateMembers(key: string, load: () => ResourceProducer[]): ResourceProducer[] {
    return readList(this.aggregateMembers, key, load);
  }

  public getOutgoing(producerId: string, load: () => ResourceEdge[]): ResourceEdge[] {
    return readList(this.outgoing, producerId, load);
  }

  public getIncoming(target: string, load: () => ResourceEdge[]): ResourceEdge[] {
    return readList(this.incoming, target, load);
  }

  public getProjectProducers(projectId: string, load: () => ResourceProducer[]): ResourceProducer[] {
    return readList(this.projectProducers, projectId, load);
  }

  public getProviderProjectProducers(key: string, load: () => ResourceProducer[]): ResourceProducer[] {
    return readList(this.providerProjectProducers, key, load);
  }

  public getResolutionPlan(
    cacheKey: string,
    projectId: string,
    create: () => ResourceUniverseResolutionPlan
  ): ResourceUniverseResolutionPlan {
    const cached = this.resolutionPlans.get(cacheKey);
    if (cached) {
      return cached;
    }
    const plan = create();
    this.resolutionPlans.set(cacheKey, plan);
    addIndexValue(this.planKeysByProject, projectId, cacheKey);
    return plan;
  }

  public getResolutionFacts(
    plan: ResourceUniverseResolutionPlan,
    targetIdentity: string
  ): ResourceUniverseResolutionFacts | undefined {
    return this.resolutionFacts.get(resolutionFactKey(plan.cacheKey, targetIdentity))?.facts;
  }

  public setResolutionFacts(
    plan: ResourceUniverseResolutionPlan,
    targetIdentity: string,
    facts: ResourceUniverseResolutionFacts
  ): void {
    const key = resolutionFactKey(plan.cacheKey, targetIdentity);
    this.resolutionFacts.set(key, { planKey: plan.cacheKey, facts });
    addIndexValue(this.factKeysByPlan, plan.cacheKey, key);
  }

  public invalidate(invalidation: ResourceUniverseQueryInvalidation): void {
    for (const projectId of invalidation.projectIds) {
      this.projectProducers.delete(projectId);
      for (const planKey of [...(this.planKeysByProject.get(projectId) ?? [])]) {
        this.resolutionPlans.delete(planKey);
      }
    }
    for (const key of invalidation.providerProjectKeys) {
      this.providerProjectProducers.delete(key);
    }
    for (const producerId of invalidation.producerIds) {
      this.outgoing.delete(producerId);
    }
    for (const key of invalidation.logicalKeys) {
      this.producersForKey.delete(key);
    }
    for (const key of invalidation.aggregateKeys) {
      this.aggregateMembers.delete(key);
    }
    for (const key of invalidation.incomingTargets) {
      this.incoming.delete(key);
    }
  }
}

export function createResourceUniverseQueryInvalidation(): ResourceUniverseQueryInvalidation {
  return {
    projectIds: new Set(),
    providerProjectKeys: new Set(),
    producerIds: new Set(),
    logicalKeys: new Set(),
    aggregateKeys: new Set(),
    incomingTargets: new Set()
  };
}

export function resourceResolutionContextIdentity(context: ResourceResolutionContext): string {
  return JSON.stringify([
    context.contextId,
    context.projectId,
    context.scope,
    context.orderedLayerIds,
    context.applicableProviderIds
  ]);
}

export function copyResourceResolutionCandidates(
  candidates: readonly ResourceResolvedCandidate[]
): ResourceResolvedCandidate[] {
  return candidates.map(candidate => ({ ...candidate }));
}

function readList<Key, Value>(
  cache: LruCache<Key, readonly Value[]>,
  key: Key,
  load: () => Value[]
): Value[] {
  let cached = cache.get(key);
  if (!cached) {
    cached = load();
    cache.set(key, cached);
  }
  return [...cached];
}

function resolutionFactKey(planKey: string, targetIdentity: string): string {
  return `${planKey}\0${targetIdentity}`;
}

function addIndexValue(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key);
  if (values) {
    values.add(value);
  } else {
    map.set(key, new Set([value]));
  }
}
