import type {
  Disposable,
  Event,
  TreeDataProvider,
  TreeItem
} from "vscode";

type TreeDataChange<T> = T | T[] | undefined | null | void;

interface TreeDataListener<T> {
  readonly callback: (event: TreeDataChange<T>) => unknown;
  readonly thisArg: unknown;
}

/**
 * Keeps the contributed tree view cheap until VS Code first asks it for data.
 * The resolved provider remains owned by its registration context; this bridge
 * only owns the event subscription that connects the two providers.
 */
export class DeferredResourceGraphTreeProvider<T>
implements TreeDataProvider<T>, Disposable {
  private readonly listeners = new Set<TreeDataListener<T>>();
  private provider: TreeDataProvider<T> | undefined;
  private providerChangeSubscription: Disposable | undefined;
  private disposed = false;

  public readonly onDidChangeTreeData: Event<TreeDataChange<T>> = (
    callback,
    thisArg,
    disposables
  ) => {
    if (this.disposed) {
      const disposable = emptyDisposable();
      disposables?.push(disposable);
      return disposable;
    }
    const listener = { callback, thisArg };
    this.listeners.add(listener);
    const disposable = onceDisposable(() => this.listeners.delete(listener));
    disposables?.push(disposable);
    return disposable;
  };

  public constructor(
    private readonly resolve: () => TreeDataProvider<T>
  ) {}

  public getTreeItem(element: T): TreeItem | Thenable<TreeItem> {
    return this.resolveProvider().getTreeItem(element);
  }

  public getChildren(element?: T): ReturnType<TreeDataProvider<T>["getChildren"]> {
    return this.resolveProvider().getChildren(element);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.providerChangeSubscription?.dispose();
    this.providerChangeSubscription = undefined;
    this.listeners.clear();
  }

  private resolveProvider(): TreeDataProvider<T> {
    if (this.provider) {
      return this.provider;
    }
    const provider = this.resolve();
    this.provider = provider;
    if (!this.disposed && provider.onDidChangeTreeData) {
      this.providerChangeSubscription = provider.onDidChangeTreeData(event => this.fire(event));
    }
    return provider;
  }

  private fire(event: TreeDataChange<T>): void {
    if (this.disposed) {
      return;
    }
    for (const listener of [...this.listeners]) {
      listener.callback.call(listener.thisArg, event);
    }
  }
}

function onceDisposable(dispose: () => void): Disposable {
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      dispose();
    }
  };
}

function emptyDisposable(): Disposable {
  return { dispose: () => undefined };
}
