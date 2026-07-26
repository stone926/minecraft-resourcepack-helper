import { normalizeOptionalPathKey, normalizePathKey } from "../../packages/mc-assets/src";
import type { JsonDocumentNode } from "../utils/jsonAst";
import type { RawModelDocument, ResolvedModel } from "../modelPreview/model/ModelDocument";
import { DependencyIndex } from "./dependencyIndex";
import { LruCache } from "./lruCache";
import {
  collectModelTextureVariableDefinitions,
  loadModelParentChain,
  modelSourceForFile,
  type CachedModelDocument,
  type CachedTextureVariableDefinition,
  type ModelParentChainHost
} from "./modelParentChain";
import { ResourceCacheMetrics } from "./resourceCacheMetrics";
import {
  openDocumentFileVersion,
  type CacheEntry,
  type CacheTextDocument,
  type ResourceCacheGenerationState,
  type ResourceConfiguration
} from "./resourceCacheTypes";

export interface ModelResourceCacheHost extends ModelParentChainHost {
  getFileVersion(fileName: string): string | null;
}

interface PreviewRawModelCacheEntry {
  value: Promise<RawModelDocument>;
  version: string | null;
}

interface PreviewResolvedModelCacheEntry {
  model: Promise<ResolvedModel | null>;
  configurationKey: string;
  dependencyKeys: Set<string>;
  dependencyVersions: Map<string, string | null> | null;
}

export class ModelResourceCache {
  private readonly modelParentChainCache = new LruCache<string, CacheEntry<CachedModelDocument[]>>(
    1024,
    key => this.modelCacheDependencies.release(`chain\0${key}`)
  );
  private readonly modelTextureDefinitionsCache = new LruCache<
    string,
    CacheEntry<ReadonlyMap<string, CachedTextureVariableDefinition>>
  >(
    1024,
    key => this.modelCacheDependencies.release(`definitions\0${key}`)
  );
  private readonly modelCacheDependencies = new DependencyIndex();
  private readonly previewRawModels = new LruCache<string, PreviewRawModelCacheEntry>(512);
  private readonly previewResolvedModels = new LruCache<string, PreviewResolvedModelCacheEntry>(512);

  constructor(
    private readonly host: ModelResourceCacheHost,
    private readonly state: ResourceCacheGenerationState,
    private readonly metrics: ResourceCacheMetrics
  ) {}

  getModelParentChain(
    document: CacheTextDocument,
    ast: JsonDocumentNode,
    configuration: ResourceConfiguration,
    source = modelSourceForFile(document.fileName)
  ): CachedModelDocument[] {
    const key = this.modelCacheKey(document, source, configuration);
    const generation = this.state.getResourceFsGeneration();
    const cached = this.modelParentChainCache.get(key);
    if (cached && cached.generation === generation) {
      this.metrics.hit("modelParentChain");
      return cached.value;
    }

    this.metrics.miss("modelParentChain");
    const chain = loadModelParentChain(this.host, document.fileName, ast, source, configuration);
    this.modelParentChainCache.set(key, { generation, value: chain });
    this.modelCacheDependencies.register(`chain\0${key}`, chain.map(model => model.fileName));
    return chain;
  }

  getModelTextureVariableDefinitions(
    document: CacheTextDocument,
    ast: JsonDocumentNode,
    configuration: ResourceConfiguration,
    source = modelSourceForFile(document.fileName)
  ): ReadonlyMap<string, CachedTextureVariableDefinition> {
    const key = this.modelCacheKey(document, source, configuration);
    const generation = this.state.getResourceFsGeneration();
    const cached = this.modelTextureDefinitionsCache.get(key);
    if (cached && cached.generation === generation) {
      this.metrics.hit("modelTextureDefinitions");
      return cached.value;
    }

    this.metrics.miss("modelTextureDefinitions");
    const chain = this.getModelParentChain(document, ast, configuration, source);
    const definitions = collectModelTextureVariableDefinitions(chain);
    this.modelTextureDefinitionsCache.set(key, { generation, value: definitions });
    this.modelCacheDependencies.register(`definitions\0${key}`, chain.map(model => model.fileName));
    return definitions;
  }

  getPreviewRawModel(fileName: string, version: string | null): Promise<RawModelDocument> | null {
    const entry = this.previewRawModels.get(normalizePathKey(fileName));
    return entry && entry.version === version ? entry.value : null;
  }

  setPreviewRawModel(
    fileName: string,
    version: string | null,
    document: Promise<RawModelDocument>
  ): void {
    this.previewRawModels.set(normalizePathKey(fileName), { version, value: document });
  }

  getPreviewResolvedModel(
    fileName: string,
    configurationKey: string,
    getVersion: (fileName: string) => string | null
  ): Promise<ResolvedModel | null> | null {
    const entry = this.previewResolvedModels.get(normalizePathKey(fileName));
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

  setPreviewResolvedModel(
    fileName: string,
    configurationKey: string,
    model: Promise<ResolvedModel | null>,
    dependencyVersions: ReadonlyMap<string, string | null>
  ): void {
    const key = normalizePathKey(fileName);
    const normalizedDependencyVersions = new Map(
      [...dependencyVersions].map(([dependency, version]) => [normalizePathKey(dependency), version])
    );
    const entry: PreviewResolvedModelCacheEntry = {
      model,
      configurationKey,
      dependencyKeys: new Set([key, ...normalizedDependencyVersions.keys()]),
      dependencyVersions: normalizedDependencyVersions
    };
    entry.model = model.then(resolvedModel => {
      if (this.previewResolvedModels.peek(key) === entry) {
        const dependencies = new Set([
          fileName,
          ...(resolvedModel?.dependencies.map(dependency => dependency.fileName) ?? [])
        ]);
        entry.dependencyKeys = new Set([
          ...entry.dependencyKeys,
          ...[...dependencies].map(dependency => normalizePathKey(dependency))
        ]);
      }
      return resolvedModel;
    });
    this.previewResolvedModels.set(key, entry);
  }

  invalidatePreviewDependents(fileName: string): void {
    const changedKey = normalizePathKey(fileName);
    this.previewRawModels.delete(changedKey);
    for (const [entryKey, entry] of this.previewResolvedModels.entries()) {
      if (entryKey === changedKey || entry.dependencyKeys.has(changedKey)) {
        this.previewResolvedModels.delete(entryKey);
      }
    }
  }

  invalidatePreviewArtifacts(): void {
    this.previewRawModels.clear();
    this.previewResolvedModels.clear();
  }

  invalidateAll(): void {
    this.modelParentChainCache.clear();
    this.modelTextureDefinitionsCache.clear();
    this.modelCacheDependencies.clear();
    this.invalidatePreviewArtifacts();
  }

  invalidatePath(fileName: string): void {
    this.deleteModelCacheDependenciesForPath(normalizePathKey(fileName));
    this.invalidatePreviewDependents(fileName);
  }

  invalidateConfiguration(): void {
    this.invalidateAll();
  }

  getSizes(): Record<string, number> {
    return {
      modelParentChain: this.modelParentChainCache.size,
      modelTextureDefinitions: this.modelTextureDefinitionsCache.size,
      rawModels: this.previewRawModels.size,
      resolvedModels: this.previewResolvedModels.size
    };
  }

  private modelCacheKey(
    document: CacheTextDocument,
    source: string,
    configuration: ResourceConfiguration
  ): string {
    const version = typeof document.version === "number"
      ? openDocumentFileVersion(document.version)
      : this.host.getFileVersion(document.fileName) ?? "unknown";
    return [
      normalizePathKey(document.fileName),
      version,
      source,
      normalizeOptionalPathKey(configuration.defaultAssetsPath),
      (configuration.resourcePackRoots ?? []).map(root => normalizePathKey(root)).join("|"),
      this.state.getConfigurationVersion()
    ].join("\0");
  }

  private deleteModelCacheDependenciesForPath(fileKey: string): void {
    for (const cacheKey of this.modelCacheDependencies.affectedCacheKeys(fileKey)) {
      if (cacheKey.startsWith("chain\0")) {
        this.modelParentChainCache.delete(cacheKey.slice("chain\0".length));
      } else if (cacheKey.startsWith("definitions\0")) {
        this.modelTextureDefinitionsCache.delete(cacheKey.slice("definitions\0".length));
      }
      this.modelCacheDependencies.release(cacheKey);
    }
  }
}
