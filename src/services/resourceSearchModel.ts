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

export function searchResourceInventory(
  inventory: readonly ResourceSearchInventoryEntry[],
  options: ResourceSearchQuery
): ResourceSearchMatch[] {
  const query = normalizeSearchText(options.query);
  if (!query || options.limit <= 0) {
    return [];
  }
  const kinds = new Set(options.kinds);
  return inventory
    .flatMap(entry => isResourceSearchKind(entry.target.kind) && kinds.has(entry.target.kind)
      ? [{
          entry,
          rank: rankEntry(entry, query)
        }]
      : [])
    .filter(candidate => candidate.rank !== null)
    .sort((left, right) =>
      left.rank! - right.rank!
      || resourceSearchKindPriority(left.entry.target.kind)
        - resourceSearchKindPriority(right.entry.target.kind)
      || left.entry.target.id.localeCompare(right.entry.target.id, "en")
    )
    .slice(0, Math.floor(options.limit))
    .map(({ entry }) => ({
      ...entry,
      kind: entry.target.kind as ResourceSearchKind,
      id: entry.target.id,
      outputPath: entry.producer.outputPath,
      sourceUri: entry.producer.sourceOrigins[0]?.uri
        ?? entry.producer.physicalOrigins[0]?.uri,
      materializationState: entry.producer.materializationState
    }));
}

export function isResourceSearchKind(value: string): value is ResourceSearchKind {
  return (resourceSearchKinds as readonly string[]).includes(value);
}

function resourceSearchKindPriority(kind: string): number {
  const index = (resourceSearchKinds as readonly string[]).indexOf(kind);
  return index >= 0 ? index : resourceSearchKinds.length;
}

function rankEntry(entry: ResourceSearchInventoryEntry, query: string): number | null {
  const id = normalizeSearchText(entry.target.id);
  const path = normalizeSearchText(entry.producer.outputPath ?? "");
  const source = normalizeSearchText(
    entry.producer.sourceOrigins[0]?.uri
      ?? entry.producer.physicalOrigins[0]?.uri
      ?? ""
  );
  const basename = resourceBasename(id);
  if (id === query || basename === query) {
    return 0;
  }
  if (id.startsWith(query) || basename.startsWith(query)) {
    return 1;
  }
  if (id.split(/[/:]/).some(segment => segment.startsWith(query))) {
    return 2;
  }
  if (id.includes(query)) {
    return 3;
  }
  if (path.includes(query)) {
    return 4;
  }
  return source.includes(query) ? 5 : null;
}

function resourceBasename(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id.replace(/^[^:]+:/, "");
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}
