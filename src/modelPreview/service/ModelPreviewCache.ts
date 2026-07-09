import type { ModelPreviewDocument } from "../ir/PreviewDocument";
import type { RawModelDocument, ResolvedModel } from "../model/ModelDocument";
import { normalizePathKey } from "../../../packages/mc-assets/src";
import { dependencyKey } from "../paths";
import type { PngAlphaMask } from "../bake/PngAlpha";
import { LruCache } from "../../services/lruCache";

interface PreviewCacheEntry {
  document: Promise<ModelPreviewDocument>;
  dependencyKeys: Set<string>;
}

interface VersionedCacheEntry<T> {
  value: Promise<T>;
  version: string | null;
}

interface ResolvedModelCacheEntry {
  model: Promise<ResolvedModel | null>;
  configurationKey: string;
  dependencyKeys: Set<string>;
  dependencyVersions: Map<string, string | null> | null;
}

export class ModelPreviewCache {
  private readonly previews = new LruCache<string, PreviewCacheEntry>(128);
  private readonly rawModels = new LruCache<string, VersionedCacheEntry<RawModelDocument>>(512);
  private readonly resolvedModels = new LruCache<string, ResolvedModelCacheEntry>(512);
  private readonly textureAlphaMasks = new LruCache<string, VersionedCacheEntry<PngAlphaMask | null>>(512);

  get(fileName: string): Promise<ModelPreviewDocument> | null {
    return this.previews.get(normalizePathKey(fileName))?.document ?? null;
  }

  set(fileName: string, document: Promise<ModelPreviewDocument>): void {
    const key = normalizePathKey(fileName);
    this.previews.set(key, {
      document: document.then(preview => {
        const entry = this.previews.get(key);
        if (entry) {
          entry.dependencyKeys = new Set(preview.dependencies.map(dependency => dependencyKey(dependency.uri)));
        }
        return preview;
      }),
      dependencyKeys: new Set([normalizePathKey(fileName)])
    });
  }

  getRawModel(fileName: string, version: string | null): Promise<RawModelDocument> | null {
    const entry = this.rawModels.get(normalizePathKey(fileName));
    return entry && entry.version === version ? entry.value : null;
  }

  setRawModel(fileName: string, version: string | null, document: Promise<RawModelDocument>): void {
    this.rawModels.set(normalizePathKey(fileName), {
      version,
      value: document
    });
  }

  getResolvedModel(
    fileName: string,
    configurationKey: string,
    getVersion: (fileName: string) => string | null
  ): Promise<ResolvedModel | null> | null {
    const entry = this.resolvedModels.get(normalizePathKey(fileName));
    if (!entry || entry.configurationKey !== configurationKey) {
      return null;
    }

    if (entry.dependencyVersions) {
      for (const [dependency, version] of entry.dependencyVersions) {
        if (getVersion(dependency) !== version) {
          return null;
        }
      }
    }

    return entry.model;
  }

  setResolvedModel(
    fileName: string,
    configurationKey: string,
    model: Promise<ResolvedModel | null>,
    getVersion: (fileName: string) => string | null
  ): void {
    const key = normalizePathKey(fileName);
    this.resolvedModels.set(key, {
      model: model.then(resolvedModel => {
        const entry = this.resolvedModels.get(key);
        if (entry) {
          const dependencies = new Set([
            fileName,
            ...(resolvedModel?.dependencies.map(dependency => dependency.fileName) ?? [])
          ]);
          entry.dependencyKeys = new Set([...dependencies].map(dependency => normalizePathKey(dependency)));
          entry.dependencyVersions = new Map([...dependencies].map(dependency => [normalizePathKey(dependency), getVersion(dependency)]));
        }
        return resolvedModel;
      }),
      configurationKey,
      dependencyKeys: new Set([normalizePathKey(fileName)]),
      dependencyVersions: null
    });
  }

  getTextureAlphaMask(fileName: string, version: string | null): Promise<PngAlphaMask | null> | null {
    const entry = this.textureAlphaMasks.get(normalizePathKey(fileName));
    return entry && entry.version === version ? entry.value : null;
  }

  setTextureAlphaMask(fileName: string, version: string | null, alphaMask: Promise<PngAlphaMask | null>): void {
    this.textureAlphaMasks.set(normalizePathKey(fileName), {
      version,
      value: alphaMask
    });
  }

  invalidate(fileName: string): void {
    this.previews.delete(normalizePathKey(fileName));
  }

  invalidateAll(): void {
    this.previews.clear();
    this.rawModels.clear();
    this.resolvedModels.clear();
    this.textureAlphaMasks.clear();
  }

  getStats(): Record<string, number> {
    return {
      previews: this.previews.size,
      rawModels: this.rawModels.size,
      resolvedModels: this.resolvedModels.size,
      textureAlphaMasks: this.textureAlphaMasks.size
    };
  }

  invalidateDependents(changedFileNameOrUri: string): void {
    const changedKey = dependencyKey(changedFileNameOrUri);
    for (const [entryKey, entry] of this.previews.entries()) {
      if (entryKey === changedKey || entry.dependencyKeys.has(changedKey)) {
        this.previews.delete(entryKey);
      }
    }
    this.rawModels.delete(changedKey);
    this.textureAlphaMasks.delete(changedKey);
    for (const [entryKey, entry] of this.resolvedModels.entries()) {
      if (entryKey === changedKey || entry.dependencyKeys.has(changedKey)) {
        this.resolvedModels.delete(entryKey);
      }
    }
  }
}
