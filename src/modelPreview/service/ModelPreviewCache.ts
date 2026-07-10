import type { ModelPreviewDocument } from "../ir/PreviewDocument";
import type { RawModelDocument, ResolvedModel } from "../model/ModelDocument";
import { normalizePathKey } from "../../../packages/mc-assets/src";
import { dependencyKey } from "../paths";
import type { PngAlphaMask } from "../bake/AlphaMask";
import { LruCache } from "../../services/lruCache";
import { WorkspaceResourceCache } from "../../services/workspaceResourceCache";

interface PreviewCacheEntry {
  document: Promise<ModelPreviewDocument>;
  dependencyKeys: Set<string>;
}

export interface ModelPreviewArtifactCacheStore {
  getRawModel(fileName: string, version: string | null): Promise<RawModelDocument> | null;
  setRawModel(fileName: string, version: string | null, document: Promise<RawModelDocument>): void;
  getResolvedModel(
    fileName: string,
    configurationKey: string,
    getVersion: (fileName: string) => string | null
  ): Promise<ResolvedModel | null> | null;
  setResolvedModel(
    fileName: string,
    configurationKey: string,
    model: Promise<ResolvedModel | null>,
    getVersion: (fileName: string) => string | null
  ): void;
  getTextureAlphaMask(fileName: string, version: string | null): Promise<PngAlphaMask | null> | null;
  setTextureAlphaMask(fileName: string, version: string | null, alphaMask: Promise<PngAlphaMask | null>): void;
  invalidateDependents(fileName: string): void;
  invalidateAll(): void;
  getStats(): Record<string, number>;
}

export class ModelPreviewCache {
  private readonly previews = new LruCache<string, PreviewCacheEntry>(128);

  constructor(
    private readonly artifacts: ModelPreviewArtifactCacheStore = new WorkspaceResourceCache().modelPreviewArtifacts
  ) {}

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
    return this.artifacts.getRawModel(fileName, version);
  }

  setRawModel(fileName: string, version: string | null, document: Promise<RawModelDocument>): void {
    this.artifacts.setRawModel(fileName, version, document);
  }

  getResolvedModel(
    fileName: string,
    configurationKey: string,
    getVersion: (fileName: string) => string | null
  ): Promise<ResolvedModel | null> | null {
    return this.artifacts.getResolvedModel(fileName, configurationKey, getVersion);
  }

  setResolvedModel(
    fileName: string,
    configurationKey: string,
    model: Promise<ResolvedModel | null>,
    getVersion: (fileName: string) => string | null
  ): void {
    this.artifacts.setResolvedModel(fileName, configurationKey, model, getVersion);
  }

  getTextureAlphaMask(fileName: string, version: string | null): Promise<PngAlphaMask | null> | null {
    return this.artifacts.getTextureAlphaMask(fileName, version);
  }

  setTextureAlphaMask(fileName: string, version: string | null, alphaMask: Promise<PngAlphaMask | null>): void {
    this.artifacts.setTextureAlphaMask(fileName, version, alphaMask);
  }

  invalidate(fileName: string): void {
    this.previews.delete(normalizePathKey(fileName));
  }

  invalidateAll(): void {
    this.previews.clear();
    this.artifacts.invalidateAll();
  }

  getStats(): Record<string, number> {
    return {
      previews: this.previews.size,
      ...this.artifacts.getStats()
    };
  }

  invalidateDependents(changedFileNameOrUri: string): void {
    const changedKey = dependencyKey(changedFileNameOrUri);
    for (const [entryKey, entry] of this.previews.entries()) {
      if (entryKey === changedKey || entry.dependencyKeys.has(changedKey)) {
        this.previews.delete(entryKey);
      }
    }
    this.artifacts.invalidateDependents(changedFileNameOrUri);
  }
}
