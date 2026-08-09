import * as path from "node:path";
import { lm } from "../../i18n/messages";
import { isCitPropertiesFileName } from "../../cit/citPaths";
import { resourceConfigurationKeys } from "../../utils/resourceConfigurationKeys";
import { normalizePathKey, type ResourceFileRequest } from "../../../packages/mc-assets/src";
import type { ModelPreviewDocument, PreviewDependency } from "../ir/PreviewDocument";
import type { ModelPreviewConfiguration, ModelPreviewFileSystem, ResolvedDependency, ResolvedModel } from "../model/ModelDocument";
import { setDependencyWithActualPriority } from "../model/DependencyPriority";
import { ModelIssueCollector } from "../model/ModelIssues";
import type { PngAlphaMask } from "../bake/AlphaMask";
import { CuboidBaker } from "../bake/CuboidBaker";
import { createGeneratedItemElements } from "../bake/GeneratedItemModel";
import { CitPreviewResolver } from "../resolve/CitPreviewResolver";
import { ParentChainResolver } from "../resolve/ParentChainResolver";
import type { ParentChainModelLoader } from "../resolve/RawModelLoader";
import { TextureReferenceResolver } from "../resolve/TextureReferenceResolver";
import { collectPackMetadataDependencies } from "../resolve/PackMetadataDependencies";
import { dependencyKey, fileUriString } from "../paths";
import { ModelPreviewCache, type ModelPreviewArtifactCacheStore } from "./ModelPreviewCache";
import { readNodePngAlphaMask } from "./NodePngAlphaMaskProvider";
import { ResourceVersionSnapshot } from "./ResourceVersionSnapshot";
import {
  isCancellationError,
  throwIfCancellationRequested,
  type ModelPreviewCancellationToken
} from "../cancellation";

export interface ModelPreviewServiceOptions {
  fileSystem: ModelPreviewFileSystem;
  configuration?: () => ModelPreviewConfiguration;
  artifactCache?: ModelPreviewArtifactCacheStore;
  /** Raw-model loading backend; hosts inject the shared workspace-cache loader. */
  modelLoader?: ParentChainModelLoader;
  /** Shared workspace resource-path resolution for non-CIT references. */
  resolveResourcePath?: (request: ResourceFileRequest) => string | null;
}

const maxConsistencyAttempts = 3;

export class ModelPreviewConsistencyError extends Error {
  constructor() {
    super("Model preview resources changed repeatedly while the preview was being built");
    this.name = "ModelPreviewConsistencyError";
  }
}

export class ModelPreviewService {
  private readonly fileSystem: ModelPreviewFileSystem;
  private readonly getConfiguration: () => ModelPreviewConfiguration;
  private readonly cache: ModelPreviewCache;
  private readonly modelLoader: ParentChainModelLoader | undefined;
  private readonly resolveResourcePath: ((request: ResourceFileRequest) => string | null) | undefined;

  constructor(options: ModelPreviewServiceOptions) {
    this.fileSystem = options.fileSystem;
    this.getConfiguration = options.configuration ?? (() => ({}));
    this.cache = new ModelPreviewCache(options.artifactCache);
    this.modelLoader = options.modelLoader;
    this.resolveResourcePath = options.resolveResourcePath;
  }

  getPreviewDocument(fileName: string, cancellationToken?: ModelPreviewCancellationToken): Promise<ModelPreviewDocument> {
    const cached = this.cache.get(fileName);
    if (cached) {
      return cached;
    }

    return this.cache.set(fileName, this.createConsistentPreviewDocument(fileName, cancellationToken));
  }

  invalidate(fileName: string): void {
    this.cache.invalidate(fileName);
  }

  invalidateAll(): void {
    this.cache.invalidateAll();
  }

  invalidateDependents(changedFileNameOrUri: string): void {
    this.cache.invalidateDependents(changedFileNameOrUri);
  }

  private async createConsistentPreviewDocument(
    fileName: string,
    cancellationToken?: ModelPreviewCancellationToken
  ): Promise<ModelPreviewDocument> {
    for (let attempt = 0; attempt < maxConsistencyAttempts; attempt++) {
      throwIfCancellationRequested(cancellationToken);
      const generation = this.resourceGeneration();
      try {
        const document = await this.createPreviewDocument(fileName, cancellationToken);
        throwIfCancellationRequested(cancellationToken);
        if (!this.previewDependenciesChangedSince(generation, fileName, document)) {
          return document;
        }
      } catch (error) {
        if (!(error instanceof PreviewResourcesChangedError)) {
          throw error;
        }
      }
    }
    throw new ModelPreviewConsistencyError();
  }

  private async createPreviewDocument(fileName: string, cancellationToken?: ModelPreviewCancellationToken): Promise<ModelPreviewDocument> {
    throwIfCancellationRequested(cancellationToken);
    const issues = new ModelIssueCollector();
    const configuration = this.getConfiguration();
    const versionSnapshot = new ResourceVersionSnapshot(dependency => this.fileVersion(dependency));
    versionSnapshot.observe(fileName);
    let additionalDependencies: ResolvedDependency[] = [];
    let model: ResolvedModel | null;
    if (isCitPropertiesFileName(fileName)) {
      const resolution = await this.resolveCitPreviewModel(
        fileName,
        configuration,
        issues,
        cancellationToken,
        versionSnapshot
      );
      model = resolution.model;
      additionalDependencies = resolution.dependencies;
    } else {
      model = await this.resolveModel(fileName, configuration, issues, cancellationToken, versionSnapshot);
    }
    throwIfCancellationRequested(cancellationToken);

    if (!versionSnapshot.consistentVersions()) {
      throw new PreviewResourcesChangedError();
    }

    return this.createPreviewDocumentFromModel(
      fileName,
      model,
      configuration,
      issues,
      cancellationToken,
      additionalDependencies
    );
  }

  private async createPreviewDocumentFromModel(
    sourceFileName: string,
    model: ResolvedModel | null,
    configuration: ModelPreviewConfiguration,
    issues: ModelIssueCollector,
    cancellationToken?: ModelPreviewCancellationToken,
    additionalDependencies: ResolvedDependency[] = []
  ): Promise<ModelPreviewDocument> {
    if (!model) {
      const resourceDependencies = [
        { fileName: sourceFileName, kind: "model" as const },
        ...additionalDependencies
      ];
      const dependencies = collectPackMetadataDependencies(
        resourceDependencies,
        configuration,
        this.fileSystem
      );
      return {
        version: 1,
        sourceUri: fileUriString(sourceFileName),
        resourceId: path.basename(sourceFileName, path.extname(sourceFileName)),
        title: path.basename(sourceFileName),
        bounds: { min: [0, 0, 0], max: [0, 0, 0] },
        meshes: [],
        materials: [],
        display: {},
        dependencies: toPreviewDependencies([...resourceDependencies, ...dependencies], true),
        issues: issues.all()
      };
    }

    const textureResolver = new TextureReferenceResolver(model, this.fileSystem, configuration, issues);
    let renderModel = model;
    if (model.generatedItem && model.elements.length === 0) {
      renderModel = {
        ...model,
        elements: await createGeneratedItemElements(
          model,
          textureResolver,
          issues,
          (textureFileName, targetIssues, token) => this.readTextureAlphaMask(textureFileName, targetIssues, token),
          cancellationToken
        )
      };
    }
    throwIfCancellationRequested(cancellationToken);

    const baker = new CuboidBaker({
      resolveMaterial: (textureReference, sourceModelFileName, referenceRange) =>
        textureResolver.resolve(textureReference, sourceModelFileName, referenceRange).material
    }, issues, cancellationToken);
    const bakeResult = baker.bake(renderModel);
    throwIfCancellationRequested(cancellationToken);

    const resourceDependencies = [
      { fileName: sourceFileName, kind: "model" as const },
      ...additionalDependencies,
      ...model.dependencies,
      ...textureResolver.allDependencies()
    ];
    const dependencies = [
      ...resourceDependencies,
      ...collectPackMetadataDependencies(
        resourceDependencies,
        configuration,
        this.fileSystem
      )
    ];

    return {
      version: 1,
      sourceUri: fileUriString(sourceFileName),
      resourceId: model.resourceId,
      title: path.basename(sourceFileName),
      bounds: bakeResult.bounds,
      meshes: bakeResult.meshes,
      materials: textureResolver.allMaterials(),
      display: model.display,
      dependencies: toPreviewDependencies(dependencies, true),
      issues: issues.all()
    };
  }

  private resolveCitPreviewModel(
    fileName: string,
    configuration: ModelPreviewConfiguration,
    issues: ModelIssueCollector,
    cancellationToken: ModelPreviewCancellationToken | undefined,
    versionSnapshot: ResourceVersionSnapshot
  ): Promise<{ model: ResolvedModel | null; dependencies: ResolvedDependency[] }> {
    const citResolver = new CitPreviewResolver(
      this.fileSystem,
      issues,
      modelFileName => this.resolveModel(
        modelFileName,
        configuration,
        issues,
        cancellationToken,
        versionSnapshot
      ),
      cancellationToken,
      dependency => versionSnapshot.observe(dependency)
    );
    return citResolver.resolve(fileName).then(model => ({
      model,
      dependencies: citResolver.allDependencies()
    }));
  }

  private async resolveModel(
    fileName: string,
    configuration: ModelPreviewConfiguration,
    issues: ModelIssueCollector,
    cancellationToken?: ModelPreviewCancellationToken,
    parentSnapshot?: ResourceVersionSnapshot
  ) {
    const resolutionKey = getResolutionKey(configuration);
    const cached = this.cache.getResolvedModel(fileName, resolutionKey, dependency => this.fileVersion(dependency));
    if (cached) {
      return cached;
    }

    const issueStart = issues.size();
    const versionSnapshot = new ResourceVersionSnapshot(dependency => this.fileVersion(dependency));
    versionSnapshot.observe(fileName);
    const modelResolver = new ParentChainResolver(
      this.fileSystem,
      configuration,
      issues,
      cancellationToken,
      this.cache,
      dependency => versionSnapshot.observe(dependency),
      this.modelLoader,
      this.resolveResourcePath
    );
    const model = await modelResolver.resolve(fileName);
    parentSnapshot?.merge(versionSnapshot);
    const dependencyVersions = versionSnapshot.consistentVersions();
    if (!dependencyVersions) {
      throw new PreviewResourcesChangedError();
    }
    if (issues.size() === issueStart) {
      this.cache.setResolvedModel(fileName, resolutionKey, Promise.resolve(model), dependencyVersions);
    }

    return model;
  }

  private async readTextureAlphaMask(
    textureFileName: string,
    issues: ModelIssueCollector,
    cancellationToken?: ModelPreviewCancellationToken
  ): Promise<PngAlphaMask | null> {
    throwIfCancellationRequested(cancellationToken);
    const version = this.fileVersion(textureFileName);
    const cached = this.cache.getTextureAlphaMask(textureFileName, version);
    if (cached) {
      const alphaMask = await cached;
      if (!alphaMask) {
        issues.info(lm("Generated item side extrusion is approximated because texture pixels could not be decoded"), textureFileName);
      }
      return alphaMask;
    }

    try {
      const bytes = await this.fileSystem.readBinaryFile(textureFileName);
      throwIfCancellationRequested(cancellationToken);
      const alphaMask = await readNodePngAlphaMask(bytes, cancellationToken);
      this.cache.setTextureAlphaMask(textureFileName, version, Promise.resolve(alphaMask));
      if (!alphaMask) {
        issues.info(lm("Generated item side extrusion is approximated because texture pixels could not be decoded"), textureFileName);
      }
      return alphaMask;
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }
    }

    issues.info(lm("Generated item side extrusion is approximated because texture pixels could not be decoded"), textureFileName);
    return null;
  }

  private fileVersion(fileName: string): string | null {
    return this.fileSystem.fileVersion?.(fileName) ?? null;
  }

  private resourceGeneration(): number {
    return this.fileSystem.getResourceGeneration?.() ?? 0;
  }

  private previewDependenciesChangedSince(
    generation: number,
    sourceFileName: string,
    document: ModelPreviewDocument
  ): boolean {
    const dependencies = [
      sourceFileName,
      ...document.dependencies
        .filter(dependency => dependency.kind !== "configuration")
        .map(dependency => dependencyKey(dependency.uri))
    ];
    return this.fileSystem.hasAnyResourceChangedSince
      ? this.fileSystem.hasAnyResourceChangedSince(generation, dependencies)
      : generation !== this.resourceGeneration();
  }
}

function toPreviewDependencies(dependencies: ResolvedDependency[], includeConfiguration: boolean): PreviewDependency[] {
  const previewDependencies = new Map<string, PreviewDependency>();
  for (const dependency of dependencies) {
    const key = `${dependency.kind}\0${normalizePathKey(dependency.fileName)}`;
    const previewDependency: PreviewDependency = {
      uri: fileUriString(dependency.fileName),
      kind: dependency.kind,
      ...(dependency.watchOnly ? { watchOnly: true } : {})
    };
    setDependencyWithActualPriority(previewDependencies, key, previewDependency);
  }

  if (includeConfiguration) {
    previewDependencies.set("configuration\0defaultMcAssetsPath", {
      uri: `configuration:${resourceConfigurationKeys.defaultAssetsPath}`,
      kind: "configuration"
    });
    previewDependencies.set("configuration\0resourcePackLoadOrder", {
      uri: `configuration:${resourceConfigurationKeys.resourcePackLoadOrder}`,
      kind: "configuration"
    });
  }

  return [...previewDependencies.values()];
}

function getResolutionKey(configuration: ModelPreviewConfiguration): string {
  return JSON.stringify({
    defaultAssetsPath: configuration.defaultAssetsPath ?? null,
    resourcePackRoots: configuration.resourcePackRoots ?? []
  });
}

class PreviewResourcesChangedError extends Error {}
