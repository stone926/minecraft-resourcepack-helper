import * as vscode from "vscode";
import {
  resourceProjectUriIdentity,
  resourceProjectUriParent,
  type SerializedResourceUri
} from "../../../packages/resource-project/src";
import {
  ArchiveResourceStore,
  ArchiveResourceStoreError,
  type ArchiveResourceSourceHost,
  type ArchiveResourceSourceStat
} from "./archiveResourceStore";
import { ZipArchiveError } from "./zipArchive";

/** VS Code workspace-fs boundary; works for local and remote serialized URIs. */
export class VscodeArchiveResourceSourceHost implements ArchiveResourceSourceHost {
  public async stat(uri: SerializedResourceUri): Promise<ArchiveResourceSourceStat | null> {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.parse(uri, true));
      return {
        type: (stat.type & vscode.FileType.File) !== 0 ? "file" : "directory",
        ctime: stat.ctime,
        mtime: stat.mtime,
        size: stat.size
      };
    } catch {
      return null;
    }
  }

  public async readFile(uri: SerializedResourceUri): Promise<Uint8Array> {
    return await vscode.workspace.fs.readFile(vscode.Uri.parse(uri, true));
  }
}

/** Thin VS Code adapter over the URI-neutral archive mount/index service. */
export class VscodeReadOnlyArchiveFileSystemProvider implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly subscriptions: Array<{ dispose(): void }>;

  public readonly onDidChangeFile = this.changes.event;

  public constructor(private readonly store: ArchiveResourceStore) {
    this.subscriptions = [
      store.onDidMount(event => {
        this.changes.fire([{
          type: vscode.FileChangeType.Created,
          uri: vscode.Uri.parse(event.rootUri, true)
        }]);
      }),
      store.onDidInvalidate(event => {
        this.changes.fire(event.invalidatedRootUris.map(rootUri => ({
          type: vscode.FileChangeType.Deleted,
          uri: vscode.Uri.parse(rootUri, true)
        })));
      })
    ];
  }

  public watch(): vscode.Disposable {
    return { dispose: () => undefined };
  }

  public stat(uri: vscode.Uri): vscode.FileStat {
    try {
      const stat = this.store.stat(uri.toString());
      return {
        type: stat.type === "file" ? vscode.FileType.File : vscode.FileType.Directory,
        ctime: stat.mtime,
        mtime: stat.mtime,
        size: stat.size,
        permissions: vscode.FilePermission.Readonly
      };
    } catch (error) {
      throw asFileSystemError(error, uri);
    }
  }

  public readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    try {
      return this.store.readDirectory(uri.toString()).map(entry => [
        entry.name,
        entry.type === "file" ? vscode.FileType.File : vscode.FileType.Directory
      ]);
    } catch (error) {
      throw asFileSystemError(error, uri);
    }
  }

  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      return await this.store.readFile(uri.toString());
    } catch (error) {
      throw asFileSystemError(error, uri);
    }
  }

  public createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(`Archive resources are read-only: ${uri.toString()}`);
  }

  public writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(`Archive resources are read-only: ${uri.toString()}`);
  }

  public delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(`Archive resources are read-only: ${uri.toString()}`);
  }

  public rename(oldUri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(`Archive resources are read-only: ${oldUri.toString()}`);
  }

  public dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
    this.changes.dispose();
  }
}

/**
 * Watches only concrete archive files after their first lazy mount. Changes
 * evict virtual revisions and route one targeted physical-provider invalidation.
 */
export class VscodeArchiveResourceSourceWatcher implements vscode.Disposable {
  private readonly watchedSources = new Map<string, vscode.Disposable>();
  private readonly mountSubscription: { dispose(): void };

  public constructor(
    private readonly store: ArchiveResourceStore,
    private readonly onSourceInvalidated: (sourceUri: vscode.Uri) => void
  ) {
    this.mountSubscription = store.onDidMount(event => this.ensureWatched(event.sourceUri));
  }

  public dispose(): void {
    this.mountSubscription.dispose();
    for (const watcher of this.watchedSources.values()) {
      watcher.dispose();
    }
    this.watchedSources.clear();
  }

  private ensureWatched(sourceUriValue: SerializedResourceUri): void {
    const identity = resourceProjectUriIdentity(sourceUriValue);
    if (this.watchedSources.has(identity)) {
      return;
    }
    const parentUri = resourceProjectUriParent(sourceUriValue);
    if (!parentUri) {
      return;
    }
    const sourceUri = vscode.Uri.parse(sourceUriValue, true);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
      vscode.Uri.parse(parentUri, true),
      "*"
    ));
    const subscriptions = [
      watcher,
      watcher.onDidCreate(changed => this.handleChange(changed, identity, sourceUri)),
      watcher.onDidChange(changed => this.handleChange(changed, identity, sourceUri)),
      watcher.onDidDelete(changed => this.handleChange(changed, identity, sourceUri))
    ];
    this.watchedSources.set(identity, vscode.Disposable.from(...subscriptions));
  }

  private handleChange(changed: vscode.Uri, identity: string, sourceUri: vscode.Uri): void {
    if (resourceProjectUriIdentity(changed.toString()) !== identity) {
      return;
    }
    this.store.invalidateSource(sourceUri.toString());
    this.onSourceInvalidated(sourceUri);
  }
}

function asFileSystemError(error: unknown, uri: vscode.Uri): vscode.FileSystemError {
  if (error instanceof ZipArchiveError) {
    if (error.code === "entryNotFound") {
      return vscode.FileSystemError.FileNotFound(uri);
    }
    if (error.code === "notDirectory") {
      return vscode.FileSystemError.FileNotADirectory(uri);
    }
    if (error.code === "isDirectory") {
      return vscode.FileSystemError.FileIsADirectory(uri);
    }
    return vscode.FileSystemError.Unavailable(error.message);
  }
  if (error instanceof ArchiveResourceStoreError) {
    return error.code === "staleResourceUri" || error.code === "invalidResourceUri"
      ? vscode.FileSystemError.FileNotFound(uri)
      : vscode.FileSystemError.Unavailable(error.message);
  }
  return vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error));
}
