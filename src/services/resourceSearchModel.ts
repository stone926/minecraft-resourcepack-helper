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

export type PreparedResourceSearchInventory =
  readonly PreparedResourceSearchInventoryEntry[];

export function prepareResourceSearchInventory(
  inventory: readonly ResourceSearchInventoryEntry[]
): PreparedResourceSearchInventory {
  return inventory.flatMap(entry => {
    if (!isResourceSearchKind(entry.target.kind)) {
      return [];
    }
    const kind = entry.target.kind;
    const id = entry.target.id;
    const outputPath = entry.producer.outputPath;
    const sourceUri = entry.producer.sourceOrigins[0]?.uri
      ?? entry.producer.physicalOrigins[0]?.uri;
    const normalizedId = normalizeSearchText(id);
    return [{
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
    }];
  });
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
  if (!query || options.limit <= 0) {
    return [];
  }
  const kinds = new Set(options.kinds);
  return inventory
    .flatMap(entry => kinds.has(entry.match.kind)
      ? [{
          entry,
          rank: rankEntry(entry, query)
        }]
      : [])
    .filter(candidate => candidate.rank !== null)
    .sort((left, right) =>
      left.rank! - right.rank!
      || resourceSearchKindPriority(left.entry.match.kind)
        - resourceSearchKindPriority(right.entry.match.kind)
      || left.entry.match.id.localeCompare(right.entry.match.id, "en")
    )
    .slice(0, Math.floor(options.limit))
    .map(({ entry }) => entry.match);
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
