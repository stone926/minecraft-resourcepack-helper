export type CitResourceIdInventoryChangeKind = "create" | "change" | "delete";

/** Data-pack inventories that contribute CIT enchantment completion IDs. */
export const citResourceIdInventoryWatcherPattern =
  "**/data/*/{enchantment,enchantments}/**";

/**
 * Lightweight structural generation shared by workspace events and the lazy
 * CIT resource-ID service. Keeping this state independent avoids pulling the
 * scanner and builtin catalog into the cold activation graph.
 */
export class CitResourceIdInventoryState {
  private generation = 0;

  currentGeneration(): number {
    return this.generation;
  }

  invalidatePath(
    fileName: string,
    kind: CitResourceIdInventoryChangeKind = "change"
  ): void {
    if (kind !== "change" && isCitResourceIdInventoryPath(fileName)) {
      this.generation++;
    }
  }

  invalidateAll(): void {
    this.generation++;
  }
}

export const citResourceIdInventoryState = new CitResourceIdInventoryState();

function isCitResourceIdInventoryPath(fileName: string): boolean {
  const normalized = fileName.replace(/\\/gu, "/");
  return /(?:^|\/)assets\/[^/]+\/(?:items|models\/item)\/.+\.json$/iu.test(normalized)
    || /(?:^|\/)data\/[^/]+\/enchantments?\/.+\.json$/iu.test(normalized);
}
