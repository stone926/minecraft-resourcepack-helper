import { normalizePathKey, readOggFileMetadata, readPngFileMetadata } from "../../packages/mc-assets/src";
import type { OggMetadata, PngMetadata } from "../../packages/mc-assets/src";
import type { PngAlphaMask } from "../modelPreview/bake/AlphaMask";
import { LruCache } from "./lruCache";
import { ResourceCacheMetrics } from "./resourceCacheMetrics";
import type { ResourceCacheGenerationState, VersionedCacheEntry } from "./resourceCacheTypes";

export interface MediaMetadataCacheHost {
  getFileVersion(fileName: string): string | null;
}

export class MediaMetadataCache {
  private readonly oggMetadataCache = new LruCache<string, VersionedCacheEntry<OggMetadata | null>>(2048);
  private readonly pngMetadataCache = new LruCache<string, VersionedCacheEntry<PngMetadata | null>>(2048);
  private readonly textureAlphaMasks = new LruCache<
    string,
    { value: Promise<PngAlphaMask | null>; version: string | null }
  >(512);

  constructor(
    private readonly host: MediaMetadataCacheHost,
    private readonly state: ResourceCacheGenerationState,
    private readonly metrics: ResourceCacheMetrics
  ) {}

  getPngMetadata(fileName: string): PngMetadata | null {
    return this.getVersionedFileValue("pngMetadata", this.pngMetadataCache, fileName, () => readPngFileMetadata(fileName));
  }

  getOggMetadata(fileName: string): OggMetadata | null {
    return this.getVersionedFileValue("oggMetadata", this.oggMetadataCache, fileName, () => readOggFileMetadata(fileName));
  }

  getTextureAlphaMask(fileName: string, version: string | null): Promise<PngAlphaMask | null> | null {
    const entry = this.textureAlphaMasks.get(normalizePathKey(fileName));
    return entry && entry.version === version ? entry.value : null;
  }

  setTextureAlphaMask(
    fileName: string,
    version: string | null,
    alphaMask: Promise<PngAlphaMask | null>
  ): void {
    this.textureAlphaMasks.set(normalizePathKey(fileName), { version, value: alphaMask });
  }

  invalidateTextureAlphaMasks(): void {
    this.textureAlphaMasks.clear();
  }

  invalidateAll(): void {
    this.oggMetadataCache.clear();
    this.pngMetadataCache.clear();
    this.invalidateTextureAlphaMasks();
  }

  invalidatePath(fileName: string): void {
    const key = normalizePathKey(fileName);
    this.oggMetadataCache.delete(key);
    this.pngMetadataCache.delete(key);
    this.textureAlphaMasks.delete(key);
  }

  invalidateDocument(fileName: string): void {
    this.invalidatePath(fileName);
  }

  getSizes(): Record<string, number> {
    return {
      oggMetadata: this.oggMetadataCache.size,
      pngMetadata: this.pngMetadataCache.size,
      textureAlphaMasks: this.textureAlphaMasks.size
    };
  }

  private getVersionedFileValue<T>(
    cacheName: string,
    cache: LruCache<string, VersionedCacheEntry<T>>,
    fileName: string,
    compute: () => T
  ): T {
    const key = normalizePathKey(fileName);
    const version = this.host.getFileVersion(fileName) ?? `missing:${this.state.getResourceFsGeneration()}`;
    const cached = cache.get(key);
    if (cached && cached.version === version) {
      this.metrics.hit(cacheName);
      return cached.value;
    }

    this.metrics.miss(cacheName);
    const value = compute();
    cache.set(key, { version, value });
    return value;
  }
}
