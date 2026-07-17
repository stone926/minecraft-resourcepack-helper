import * as fs from "node:fs";
import { normalizePathKey } from "../../packages/mc-assets/src";
import { LruCache } from "./lruCache";

export type WatcherTrustProvider = (fileName: string) => boolean;

export interface FileFreshnessPolicyOptions {
  verificationTtlMs?: number;
  now?: () => number;
  stat?: (fileName: string) => { mtimeMs: number; size: number } | null;
}

interface VerificationEntry {
  expiresAt: number;
  version: string | null;
}

/**
 * Separates watcher-backed identity from best-effort verification for paths
 * that are not covered by a workspace watcher.
 *
 * A trusted path never performs a stat on a hot lookup. Its version advances
 * only through the explicit invalidation delivered by the watcher. External
 * paths use a short TTL before checking mtime/size again, so they remain
 * eventually consistent without turning every cache hit into a filesystem
 * syscall.
 */
export class FileFreshnessPolicy {
  private readonly verificationTtlMs: number;
  private readonly now: () => number;
  private readonly stat: (fileName: string) => { mtimeMs: number; size: number } | null;
  private readonly verificationEntries = new LruCache<string, VerificationEntry>(4096);
  private readonly watchedPathGenerations = new LruCache<string, number>(8192);
  private watcherTrustProvider: WatcherTrustProvider | null = null;
  private watchedGlobalGeneration = 0;

  public constructor(options: FileFreshnessPolicyOptions = {}) {
    this.verificationTtlMs = Math.max(0, options.verificationTtlMs ?? 1_000);
    this.now = options.now ?? Date.now;
    this.stat = options.stat ?? statFile;
  }

  public setWatcherTrustProvider(provider: WatcherTrustProvider | null): void {
    if (provider === this.watcherTrustProvider) {
      return;
    }
    this.watcherTrustProvider = provider;
    this.invalidateAll();
  }

  public isWatcherTrusted(fileName: string): boolean {
    try {
      return this.watcherTrustProvider?.(fileName) === true;
    } catch {
      return false;
    }
  }

  public getFileVersion(fileName: string): string | null {
    const key = normalizePathKey(fileName);
    if (this.isWatcherTrusted(fileName)) {
      return `watch:${this.watchedGlobalGeneration}:${this.watchedPathGenerations.get(key) ?? 0}`;
    }

    const now = this.now();
    const cached = this.verificationEntries.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.version;
    }

    const stat = this.stat(fileName);
    const version = stat ? `${stat.mtimeMs}:${stat.size}` : null;
    this.verificationEntries.set(key, {
      expiresAt: now + this.verificationTtlMs,
      version
    });
    return version;
  }

  public canReuseVerifiedValue(fileName: string, verifiedAt: number): boolean {
    return this.isWatcherTrusted(fileName)
      || verifiedAt + this.verificationTtlMs > this.now();
  }

  public canReuseVerifiedPaths(fileNames: readonly string[], verifiedAt: number): boolean {
    return fileNames.every(fileName => this.isWatcherTrusted(fileName))
      || verifiedAt + this.verificationTtlMs > this.now();
  }

  public verificationTimestamp(): number {
    return this.now();
  }

  public invalidatePath(fileName: string): void {
    const key = normalizePathKey(fileName);
    this.verificationEntries.delete(key);
    this.watchedPathGenerations.set(
      key,
      (this.watchedPathGenerations.get(key) ?? 0) + 1
    );
  }

  public invalidateAll(): void {
    this.watchedGlobalGeneration++;
    this.verificationEntries.clear();
    this.watchedPathGenerations.clear();
  }
}

function statFile(fileName: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = fs.statSync(fileName);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}
