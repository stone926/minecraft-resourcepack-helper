export interface ResourceCacheRefreshTarget {
  invalidateAll(): void;
}

export interface ResourceDiagnosticsRefreshTarget {
  refreshAll(): void;
}

export interface ResourceGraphRefreshTarget {
  refresh(): void;
}

/** Coordinates the explicit escape hatch for unwatched external resource roots. */
export class ResourceRefreshCoordinator {
  public constructor(
    private readonly cache: ResourceCacheRefreshTarget,
    private readonly diagnostics: ResourceDiagnosticsRefreshTarget,
    private readonly graph: ResourceGraphRefreshTarget
  ) {}

  public refreshAll(): void {
    this.cache.invalidateAll();
    this.diagnostics.refreshAll();
    this.graph.refresh();
  }
}
