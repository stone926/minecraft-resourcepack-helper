import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePathKey } from "../../packages/mc-assets/src";

export interface ResourceStructureOperationFileSystem {
  isDirectory(fileName: string): boolean;
  pathExists(fileName: string): boolean;
}

export interface ResourceStructureOperationTrackerOptions {
  fileSystem?: ResourceStructureOperationFileSystem;
  resourceDescendantExists?: (directory: string) => Promise<boolean>;
  now?: () => number;
  pendingTtlMs?: number;
  maxPendingPaths?: number;
}

/**
 * Remembers resource directories before VS Code deletes or renames them, then
 * classifies the matching post-operation event without broad invalidation for
 * ordinary leaf files or unrelated workspace paths.
 */
export class ResourceStructureOperationTracker {
  private readonly pending = new Map<string, number>();
  private readonly fileSystem: ResourceStructureOperationFileSystem;
  private readonly resourceDescendantExists: (directory: string) => Promise<boolean>;
  private readonly now: () => number;
  private readonly pendingTtlMs: number;
  private readonly maxPendingPaths: number;

  public constructor(options: ResourceStructureOperationTrackerOptions = {}) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.resourceDescendantExists = options.resourceDescendantExists ?? (async () => false);
    this.now = options.now ?? Date.now;
    // File operations on large packs or network volumes can take substantially
    // longer than the gap between a typical onWill/onDid pair. Late expiry is
    // harmless (at worst one conservative refresh); early expiry loses the old
    // path after it has disappeared from disk.
    this.pendingTtlMs = Math.max(0, options.pendingTtlMs ?? 5 * 60_000);
    this.maxPendingPaths = Math.max(1, options.maxPendingPaths ?? 256);
  }

  public rememberBefore(fileNames: Iterable<string>): void {
    this.prune();
    const expiresAt = this.now() + this.pendingTtlMs;
    for (const fileName of fileNames) {
      // The old tree is still available here, so one stat is enough to reject
      // ordinary files. Record unknown directories conservatively: recursively
      // searching them from an onWill handler would block the user's file
      // operation, and the bounded map limits the cost of false positives.
      if (!this.isExistingDirectory(fileName)) {
        continue;
      }
      const key = normalizePathKey(path.resolve(fileName));
      this.pending.delete(key);
      this.pending.set(key, expiresAt);
      while (this.pending.size > this.maxPendingPaths) {
        const oldest = this.pending.keys().next().value as string | undefined;
        if (oldest === undefined) {
          break;
        }
        this.pending.delete(oldest);
      }
    }
  }

  public async consumeAfter(fileNames: Iterable<string>): Promise<boolean> {
    this.prune();
    const resolvedFileNames = [...fileNames].map(fileName => path.resolve(fileName));
    let rememberedDirectoryChanged = false;
    for (const fileName of resolvedFileNames) {
      const key = normalizePathKey(fileName);
      rememberedDirectoryChanged = this.pending.delete(key) || rememberedDirectoryChanged;
    }
    if (rememberedDirectoryChanged) {
      return true;
    }
    for (const fileName of resolvedFileNames) {
      if (await this.isResourceTreeDirectory(fileName)) {
        return true;
      }
    }
    return false;
  }

  public clear(): void {
    this.pending.clear();
  }

  private async isResourceTreeDirectory(fileName: string): Promise<boolean> {
    if (!this.isExistingDirectory(fileName)) {
      return false;
    }

    const segments = path.resolve(fileName).split(path.sep).map(segment => segment.toLowerCase());
    if (segments.includes("assets")
      || this.fileSystem.pathExists(path.join(fileName, "assets"))
      || this.fileSystem.pathExists(path.join(fileName, "pack.mcmeta"))) {
      return true;
    }

    // VS Code can fold a recursive create/delete/rename into a single event for
    // a grouping directory. Let the integration provide an asynchronous,
    // bounded descendant query so nested packs are not missed without putting a
    // synchronous tree walk on the extension-host event path.
    try {
      return await this.resourceDescendantExists(fileName);
    } catch {
      // A failed query means coverage is unknown. A one-off full refresh is
      // safer than retaining a stale pack inventory.
      return true;
    }
  }

  private isExistingDirectory(fileName: string): boolean {
    try {
      return this.fileSystem.isDirectory(fileName);
    } catch {
      return false;
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.pending) {
      if (expiresAt <= now) {
        this.pending.delete(key);
      }
    }
  }
}

const nodeFileSystem: ResourceStructureOperationFileSystem = {
  isDirectory: fileName => fs.statSync(fileName).isDirectory(),
  pathExists: fs.existsSync
};
