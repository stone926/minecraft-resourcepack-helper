import type * as vscode from "vscode";
import type {
  ResourceLayerDescriptor
} from "../../../packages/resource-project/src";
import type {
  ArchiveResourceStore,
  ReadOnlyArchiveMount
} from "./archiveResourceStore";

interface LoadedArchiveResources {
  store: ArchiveResourceStore;
  dispose(): void;
}

type ArchiveResourceModules = readonly [
  typeof import("./archiveResourceStore.js"),
  typeof import("./vscodeReadOnlyArchiveFileSystem.js")
];

/**
 * Defers ZIP parsing, zlib, and the virtual filesystem adapter until a project
 * actually declares an archive layer. Directory-only packs pay no archive
 * initialization cost during extension activation.
 */
export class LazyVscodeArchiveResources implements vscode.Disposable {
  private loadPromise?: Promise<LoadedArchiveResources>;
  private loaded?: LoadedArchiveResources;
  private disposed = false;

  public constructor(
    private readonly vscodeApi: typeof vscode,
    private readonly onSourceInvalidated: (sourceUri: vscode.Uri) => void,
    private readonly loadModules: () => Promise<ArchiveResourceModules> = loadArchiveResourceModules
  ) {}

  public async mountLayer(
    descriptor: ResourceLayerDescriptor,
    signal: AbortSignal
  ): Promise<ReadOnlyArchiveMount> {
    const resources = await this.ensureLoaded();
    return resources.store.mountLayer(descriptor, signal);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const loaded = this.loaded;
    this.loaded = undefined;
    loaded?.dispose();
  }

  private ensureLoaded(): Promise<LoadedArchiveResources> {
    if (this.disposed) {
      return Promise.reject(new Error("Archive resources have been disposed."));
    }
    return this.loadPromise ??= this.loadModules().then(([storeModule, vscodeModule]) => {
      if (this.disposed) {
        throw new Error("Archive resources were disposed while loading.");
      }
      const initialized: vscode.Disposable[] = [];
      try {
        const store = new storeModule.ArchiveResourceStore(
          new vscodeModule.VscodeArchiveResourceSourceHost()
        );
        initialized.push(store);
        const fileSystem = new vscodeModule.VscodeReadOnlyArchiveFileSystemProvider(store);
        initialized.push(fileSystem);
        const registration = this.vscodeApi.workspace.registerFileSystemProvider(
          storeModule.readOnlyArchiveResourceScheme,
          fileSystem,
          { isCaseSensitive: true, isReadonly: true }
        );
        initialized.push(registration);
        const sourceWatcher = new vscodeModule.VscodeArchiveResourceSourceWatcher(
          store,
          this.onSourceInvalidated
        );
        initialized.push(sourceWatcher);
        const loaded: LoadedArchiveResources = {
          store,
          dispose: () => disposeReverse(initialized)
        };
        if (this.disposed) {
          loaded.dispose();
          throw new Error("Archive resources were disposed while loading.");
        }
        this.loaded = loaded;
        return loaded;
      } catch (error) {
        disposeReverse(initialized);
        throw error;
      }
    }).catch(error => {
      if (!this.disposed) {
        this.loadPromise = undefined;
      }
      throw error;
    });
  }
}

function disposeReverse(disposables: vscode.Disposable[]): void {
  for (const disposable of disposables.splice(0).reverse()) {
    try {
      disposable.dispose();
    } catch {
      // Cleanup is best-effort and must preserve the initialization failure.
    }
  }
}

async function loadArchiveResourceModules(): Promise<ArchiveResourceModules> {
  return await Promise.all([
    import("./archiveResourceStore.js"),
    import("./vscodeReadOnlyArchiveFileSystem.js")
  ]);
}
