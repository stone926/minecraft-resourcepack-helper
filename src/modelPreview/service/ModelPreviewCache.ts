import type { ModelPreviewDocument } from "../ir/PreviewDocument";
import type { RawModelDocument, ResolvedModel } from "../model/ModelDocument";
import { fileNameKey } from "../resolve/ResourceDependencyResolver";
import type { PngAlphaMask } from "../bake/PngAlpha";
import { fileURLToPath } from "node:url";

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
  private readonly previews = new Map<string, PreviewCacheEntry>();
  private readonly rawModels = new Map<string, VersionedCacheEntry<RawModelDocument>>();
  private readonly resolvedModels = new Map<string, ResolvedModelCacheEntry>();
  private readonly textureAlphaMasks = new Map<string, VersionedCacheEntry<PngAlphaMask | null>>();

  get(fileName: string): Promise<ModelPreviewDocument> | null {
    return this.previews.get(fileNameKey(fileName))?.document ?? null;
  }

  set(fileName: string, document: Promise<ModelPreviewDocument>): void {
    const key = fileNameKey(fileName);
    this.previews.set(key, {
      document: document.then(preview => {
        const entry = this.previews.get(key);
        if (entry) {
          entry.dependencyKeys = new Set(preview.dependencies.map(dependency => dependencyKey(dependency.uri)));
        }
        return preview;
      }),
      dependencyKeys: new Set([fileNameKey(fileName)])
    });
  }

  getRawModel(fileName: string, version: string | null): Promise<RawModelDocument> | null {
    const entry = this.rawModels.get(fileNameKey(fileName));
    return entry && entry.version === version ? entry.value : null;
  }

  setRawModel(fileName: string, version: string | null, document: Promise<RawModelDocument>): void {
    this.rawModels.set(fileNameKey(fileName), {
      version,
      value: document
    });
  }

  getResolvedModel(
    fileName: string,
    configurationKey: string,
    getVersion: (fileName: string) => string | null
  ): Promise<ResolvedModel | null> | null {
    const entry = this.resolvedModels.get(fileNameKey(fileName));
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
    const key = fileNameKey(fileName);
    this.resolvedModels.set(key, {
      model: model.then(resolvedModel => {
        const entry = this.resolvedModels.get(key);
        if (entry) {
          const dependencies = new Set([
            fileName,
            ...(resolvedModel?.dependencies.map(dependency => dependency.fileName) ?? [])
          ]);
          entry.dependencyKeys = new Set([...dependencies].map(dependency => fileNameKey(dependency)));
          entry.dependencyVersions = new Map([...dependencies].map(dependency => [fileNameKey(dependency), getVersion(dependency)]));
        }
        return resolvedModel;
      }),
      configurationKey,
      dependencyKeys: new Set([fileNameKey(fileName)]),
      dependencyVersions: null
    });
  }

  getTextureAlphaMask(fileName: string, version: string | null): Promise<PngAlphaMask | null> | null {
    const entry = this.textureAlphaMasks.get(fileNameKey(fileName));
    return entry && entry.version === version ? entry.value : null;
  }

  setTextureAlphaMask(fileName: string, version: string | null, alphaMask: Promise<PngAlphaMask | null>): void {
    this.textureAlphaMasks.set(fileNameKey(fileName), {
      version,
      value: alphaMask
    });
  }

  invalidate(fileName: string): void {
    this.previews.delete(fileNameKey(fileName));
  }

  invalidateAll(): void {
    this.previews.clear();
    this.rawModels.clear();
    this.resolvedModels.clear();
    this.textureAlphaMasks.clear();
  }

  invalidateDependents(changedFileNameOrUri: string): void {
    const changedKey = dependencyKey(changedFileNameOrUri);
    for (const [entryKey, entry] of this.previews) {
      if (entryKey === changedKey || entry.dependencyKeys.has(changedKey)) {
        this.previews.delete(entryKey);
      }
    }
    this.rawModels.delete(changedKey);
    this.textureAlphaMasks.delete(changedKey);
    for (const [entryKey, entry] of this.resolvedModels) {
      if (entryKey === changedKey || entry.dependencyKeys.has(changedKey)) {
        this.resolvedModels.delete(entryKey);
      }
    }
  }
}

function dependencyKey(value: string): string {
  if (value.startsWith("file://")) {
    try {
      return fileNameKey(fileURLToPath(value));
    } catch {
      return value.toLowerCase();
    }
  }

  return fileNameKey(value);
}
