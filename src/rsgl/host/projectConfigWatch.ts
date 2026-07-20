import {
  getRsglProjectConfigWatchPaths,
  type RsglProjectConfigAnchorKind
} from "../../../packages/rsgl-core/src/rsglConfig";
import {
  DependencyWatchRegistry,
  type DependencyWatchDisposable,
  type DependencyWatchUpdate
} from "./dependencyWatch";

export type RsglProjectConfigWatcherFactory = (
  fileName: string,
  onDidChange: () => void
) => DependencyWatchDisposable;

/**
 * Watches only the exact ancestor config paths that can affect an anchor.
 * Refreshing after every event follows deletion fallbacks and newly created
 * closer configs without installing a broad watcher outside the workspace.
 */
export class RsglProjectConfigWatchRegistry implements DependencyWatchDisposable {
  private readonly watchers: DependencyWatchRegistry;
  private disposed = false;

  public constructor(
    private readonly anchorFileName: string,
    private readonly anchorKind: RsglProjectConfigAnchorKind,
    createWatcher: RsglProjectConfigWatcherFactory,
    private readonly onDidChange: () => void
  ) {
    this.watchers = new DependencyWatchRegistry(fileName =>
      createWatcher(fileName, () => this.handleConfigChange())
    );
    this.refresh();
  }

  public refresh(): DependencyWatchUpdate {
    if (this.disposed) {
      return { added: [], removed: [] };
    }
    return this.watchers.update(getRsglProjectConfigWatchPaths(
      this.anchorFileName,
      this.anchorKind
    ));
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.watchers.dispose();
  }

  private handleConfigChange(): void {
    if (this.disposed) {
      return;
    }
    this.refresh();
    this.onDidChange();
  }
}
