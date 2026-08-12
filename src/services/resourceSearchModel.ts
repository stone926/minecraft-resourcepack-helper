import type { ResourceGraphLogicalKey } from "../../packages/mc-assets/src";
import type {
  ResourceMaterializationState,
  ResourceProducer
} from "../resourceUniverse";
import type { ResourceGraphNodeNavigation } from "../views/resourceGraphTreeTypes";

export const resourceSearchKinds = ["blockstate", "model", "texture"] as const;
export type ResourceSearchKind = typeof resourceSearchKinds[number];

export interface ResourceSearchInventoryEntry {
  target: ResourceGraphLogicalKey;
  producer: ResourceProducer;
  candidates?: readonly ResourceProducer[];
  resolutionStatus: "resolved" | "multiple" | "missing" | "incomplete" | "conflict";
  navigation: ResourceGraphNodeNavigation;
}

export interface ResourceSearchMatch extends ResourceSearchInventoryEntry {
  kind: ResourceSearchKind;
  id: string;
  outputPath?: string;
  sourceUri?: string;
  materializationState: ResourceMaterializationState;
}

export interface ResourceSearchQuery {
  query: string;
  kinds: readonly ResourceSearchKind[];
  limit: number;
}

export interface PreparedResourceSearchInventoryEntry {
  readonly match: ResourceSearchMatch;
  readonly normalizedId: string;
  readonly normalizedBasename: string;
  readonly normalizedSegments: readonly string[];
  readonly normalizedOutputPath: string;
  readonly normalizedSourceUri: string;
}

export interface PreparedResourceSearchInventory {
  /** Entries are stable-sorted by canonical id once, outside the query hot path. */
  readonly byKind: Readonly<Record<
    ResourceSearchKind,
    readonly PreparedResourceSearchInventoryEntry[]
  >>;
  readonly size: number;
}

export function prepareResourceSearchInventory(
  inventory: readonly ResourceSearchInventoryEntry[]
): PreparedResourceSearchInventory {
  const byKind: Record<ResourceSearchKind, PreparedResourceSearchInventoryEntry[]> = {
    blockstate: [],
    model: [],
    texture: []
  };
  let size = 0;
  for (const entry of inventory) {
    if (!isResourceSearchKind(entry.target.kind)) {
      continue;
    }
    const kind = entry.target.kind;
    const id = entry.target.id;
    const outputPath = entry.producer.outputPath;
    const sourceUri = entry.producer.sourceOrigins[0]?.uri
      ?? entry.producer.physicalOrigins[0]?.uri;
    const normalizedId = normalizeSearchText(id);
    byKind[kind].push({
      match: {
        ...entry,
        kind,
        id,
        outputPath,
        sourceUri,
        materializationState: entry.producer.materializationState
      },
      normalizedId,
      normalizedBasename: resourceBasename(normalizedId),
      normalizedSegments: normalizedId.split(/[/:]/),
      normalizedOutputPath: normalizeSearchText(outputPath ?? ""),
      normalizedSourceUri: normalizeSearchText(sourceUri ?? "")
    });
    size++;
  }
  for (const kind of resourceSearchKinds) {
    byKind[kind].sort((left, right) =>
      left.match.id.localeCompare(right.match.id, "en")
    );
  }
  return { byKind, size };
}

export function searchResourceInventory(
  inventory: readonly ResourceSearchInventoryEntry[],
  options: ResourceSearchQuery
): ResourceSearchMatch[] {
  return searchPreparedResourceInventory(
    prepareResourceSearchInventory(inventory),
    options
  );
}

export function searchPreparedResourceInventory(
  inventory: PreparedResourceSearchInventory,
  options: ResourceSearchQuery
): ResourceSearchMatch[] {
  const query = normalizeSearchText(options.query);
  const limit = Math.floor(options.limit);
  if (!query || limit <= 0 || Number.isNaN(limit)) {
    return [];
  }
  const kinds = new Set(options.kinds);
  const buckets = createResultBuckets();
  for (const kind of resourceSearchKinds) {
    if (!kinds.has(kind)) {
      continue;
    }
    const kindPriority = resourceSearchKindPriority(kind);
    for (const entry of inventory.byKind[kind]) {
      const rank = rankEntry(entry, query);
      if (rank === null) {
        continue;
      }
      const bucket = buckets[rank][kindPriority];
      // The final response cannot consume more than `limit` entries from one
      // rank/kind bucket. Entries were sorted once during preparation, so the
      // query path never allocates and sorts every match in a large pack.
      if (bucket.length < limit) {
        bucket.push(entry.match);
      }
    }
  }

  const matches: ResourceSearchMatch[] = [];
  for (const ranked of buckets) {
    for (const bucket of ranked) {
      const remaining = limit - matches.length;
      if (remaining <= 0) {
        return matches;
      }
      matches.push(...bucket.slice(0, remaining));
    }
  }
  return matches;
}

export function resourceSearchQueryKey(options: ResourceSearchQuery): string {
  const kinds = resourceSearchKinds.filter(kind => options.kinds.includes(kind));
  return JSON.stringify([
    normalizeSearchText(options.query),
    kinds,
    Math.floor(options.limit)
  ]);
}

export function isResourceSearchKind(value: string): value is ResourceSearchKind {
  return (resourceSearchKinds as readonly string[]).includes(value);
}

function resourceSearchKindPriority(kind: string): number {
  const index = (resourceSearchKinds as readonly string[]).indexOf(kind);
  return index >= 0 ? index : resourceSearchKinds.length;
}

function createResultBuckets(): ResourceSearchMatch[][][] {
  return Array.from({ length: 6 }, () =>
    resourceSearchKinds.map(() => [] as ResourceSearchMatch[])
  );
}

function rankEntry(entry: PreparedResourceSearchInventoryEntry, query: string): number | null {
  if (entry.normalizedId === query || entry.normalizedBasename === query) {
    return 0;
  }
  if (entry.normalizedId.startsWith(query) || entry.normalizedBasename.startsWith(query)) {
    return 1;
  }
  if (entry.normalizedSegments.some(segment => segment.startsWith(query))) {
    return 2;
  }
  if (entry.normalizedId.includes(query)) {
    return 3;
  }
  if (entry.normalizedOutputPath.includes(query)) {
    return 4;
  }
  return entry.normalizedSourceUri.includes(query) ? 5 : null;
}

function resourceBasename(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id.replace(/^[^:]+:/, "");
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}
