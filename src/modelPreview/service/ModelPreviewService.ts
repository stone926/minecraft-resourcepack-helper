import * as fs from "node:fs";
import * as path from "node:path";
import { lm } from "../../i18n/messages";
import { isCitPropertiesFileName } from "../../cit/citPaths";
import { normalizePathKey } from "../../../packages/mc-assets/src";
import type { ModelPreviewDocument, PreviewDependency } from "../ir/PreviewDocument";
import type { ModelPreviewConfiguration, ModelPreviewFileSystem, ResolvedDependency, ResolvedModel } from "../model/ModelDocument";
import { ModelIssueCollector } from "../model/ModelIssues";
import type { PngAlphaMask } from "../bake/AlphaMask";
import { CuboidBaker } from "../bake/CuboidBaker";
import { createGeneratedItemElements } from "../bake/GeneratedItemModel";
import { CitPreviewResolver } from "../resolve/CitPreviewResolver";
import { ParentChainResolver } from "../resolve/ParentChainResolver";
import { TextureReferenceResolver } from "../resolve/TextureReferenceResolver";
import { fileUriString } from "../paths";
import { ModelPreviewCache } from "./ModelPreviewCache";
import { readNodePngAlphaMask } from "./NodePngAlphaMaskProvider";
import {
  isCancellationError,
  throwIfCancellationRequested,
  type ModelPreviewCancellationToken
} from "../cancellation";

export interface ModelPreviewServiceOptions {
  fileSystem?: ModelPreviewFileSystem;
  configuration?: () => ModelPreviewConfiguration;
}

export class ModelPreviewService {
  private readonly fileSystem: ModelPreviewFileSystem;
  private readonly getConfiguration: () => ModelPreviewConfiguration;
  private readonly cache = new ModelPreviewCache();

  constructor(options: ModelPreviewServiceOptions = {}) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.getConfiguration = options.configuration ?? (() => ({}));
  }

  getPreviewDocument(fileName: string, cancellationToken?: ModelPreviewCancellationToken): Promise<ModelPreviewDocument> {
    const cached = this.cache.get(fileName);
    if (cached) {
      return cached;
    }

    const document = this.createPreviewDocument(fileName, cancellationToken).catch(error => {
      this.cache.invalidate(fileName);
      throw error;
    });
    this.cache.set(fileName, document);
    return document;
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

  private async createPreviewDocument(fileName: string, cancellationToken?: ModelPreviewCancellationToken): Promise<ModelPreviewDocument> {
    throwIfCancellationRequested(cancellationToken);
    const issues = new ModelIssueCollector();
    const configuration = this.getConfiguration();
    const model = isCitPropertiesFileName(fileName)
      ? await this.resolveCitPreviewModel(fileName, configuration, issues, cancellationToken)
      : await this.resolveModel(fileName, configuration, issues, cancellationToken);
    throwIfCancellationRequested(cancellationToken);

    return this.createPreviewDocumentFromModel(fileName, model, configuration, issues, cancellationToken);
  }

  private async createPreviewDocumentFromModel(
    sourceFileName: string,
    model: ResolvedModel | null,
    configuration: ModelPreviewConfiguration,
    issues: ModelIssueCollector,
    cancellationToken?: ModelPreviewCancellationToken
  ): Promise<ModelPreviewDocument> {
    if (!model) {
      return {
        version: 1,
        sourceUri: fileUriString(sourceFileName),
        resourceId: path.basename(sourceFileName, path.extname(sourceFileName)),
        title: path.basename(sourceFileName),
        bounds: { min: [0, 0, 0], max: [0, 0, 0] },
        meshes: [],
        materials: [],
        display: {},
        dependencies: toPreviewDependencies([], true),
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

    const dependencies = [
      { fileName: sourceFileName, kind: "model" as const },
      ...model.dependencies,
      ...textureResolver.allDependencies()
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
    cancellationToken?: ModelPreviewCancellationToken
  ): Promise<ResolvedModel | null> {
    const citResolver = new CitPreviewResolver(
      this.fileSystem,
      issues,
      modelFileName => this.resolveModel(modelFileName, configuration, issues, cancellationToken),
      cancellationToken
    );
    return citResolver.resolve(fileName);
  }

  private async resolveModel(
    fileName: string,
    configuration: ModelPreviewConfiguration,
    issues: ModelIssueCollector,
    cancellationToken?: ModelPreviewCancellationToken
  ) {
    const configurationKey = getConfigurationKey(configuration);
    const cached = this.cache.getResolvedModel(fileName, configurationKey, dependency => this.fileVersion(dependency));
    if (cached) {
      return cached;
    }

    const issueStart = issues.size();
    const modelResolver = new ParentChainResolver(
      this.fileSystem,
      configuration,
      issues,
      cancellationToken,
      this.cache
    );
    const model = await modelResolver.resolve(fileName);
    if (issues.size() === issueStart) {
      this.cache.setResolvedModel(fileName, configurationKey, Promise.resolve(model), dependency => this.fileVersion(dependency));
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
}

function toPreviewDependencies(dependencies: ResolvedDependency[], includeConfiguration: boolean): PreviewDependency[] {
  const previewDependencies = new Map<string, PreviewDependency>();
  for (const dependency of dependencies) {
    const key = `${dependency.kind}\0${normalizePathKey(dependency.fileName)}`;
    previewDependencies.set(key, {
      uri: fileUriString(dependency.fileName),
      kind: dependency.kind
    });
  }

  if (includeConfiguration) {
    previewDependencies.set("configuration\0defaultMcAssetsPath", {
      uri: "configuration:McResHelper.defaultMcAssetsPath",
      kind: "configuration"
    });
    previewDependencies.set("configuration\0resourcePackLoadOrder", {
      uri: "configuration:McResHelper.resourcePackLoadOrder",
      kind: "configuration"
    });
  }

  return [...previewDependencies.values()];
}

const nodeFileSystem: ModelPreviewFileSystem = {
  readTextFile: fileName => fs.promises.readFile(fileName, "utf8"),
  readBinaryFile: fileName => fs.promises.readFile(fileName),
  fileExists: fileName => fs.existsSync(fileName),
  fileVersion: fileName => {
    try {
      const stat = fs.statSync(fileName);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }
};

function getConfigurationKey(configuration: ModelPreviewConfiguration): string {
  return JSON.stringify({
    defaultAssetsPath: configuration.defaultAssetsPath ?? null,
    resourcePackRoots: configuration.resourcePackRoots ?? []
  });
}
