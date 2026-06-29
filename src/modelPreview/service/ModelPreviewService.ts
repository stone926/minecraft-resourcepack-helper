import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelPreviewDocument, PreviewDependency } from "../ir/PreviewDocument";
import type { ModelPreviewConfiguration, ModelPreviewFileSystem, ResolvedDependency } from "../model/ModelDocument";
import { ModelIssueCollector } from "../model/ModelIssues";
import { CuboidBaker } from "../bake/CuboidBaker";
import { ParentChainResolver } from "../resolve/ParentChainResolver";
import { fileNameKey, fileUriString } from "../resolve/ResourceDependencyResolver";
import { TextureReferenceResolver } from "../resolve/TextureReferenceResolver";
import { ModelPreviewCache } from "./ModelPreviewCache";

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

  getPreviewDocument(fileName: string): Promise<ModelPreviewDocument> {
    const cached = this.cache.get(fileName);
    if (cached) {
      return cached;
    }

    const document = this.createPreviewDocument(fileName).catch(error => {
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

  private async createPreviewDocument(fileName: string): Promise<ModelPreviewDocument> {
    const issues = new ModelIssueCollector();
    const configuration = this.getConfiguration();
    const modelResolver = new ParentChainResolver(this.fileSystem, configuration, issues);
    const model = await modelResolver.resolve(fileName);

    if (!model) {
      return {
        version: 1,
        sourceUri: fileUriString(fileName),
        resourceId: path.basename(fileName, path.extname(fileName)),
        title: path.basename(fileName),
        bounds: { min: [0, 0, 0], max: [0, 0, 0] },
        meshes: [],
        materials: [],
        display: {},
        dependencies: toPreviewDependencies([], true),
        issues: issues.all()
      };
    }

    const textureResolver = new TextureReferenceResolver(model, this.fileSystem, configuration, issues);
    const baker = new CuboidBaker(textureResolver, issues);
    const bakeResult = baker.bake(model);

    if (model.generatedItem) {
      issues.info("Generated item model is approximated as a thin preview plane", model.fileName);
    }

    const dependencies = [
      ...model.dependencies,
      ...textureResolver.allDependencies()
    ];

    return {
      version: 1,
      sourceUri: fileUriString(model.fileName),
      resourceId: model.resourceId,
      title: path.basename(model.fileName),
      bounds: bakeResult.bounds,
      meshes: bakeResult.meshes,
      materials: textureResolver.allMaterials(),
      display: model.display,
      dependencies: toPreviewDependencies(dependencies, true),
      issues: issues.all()
    };
  }
}

function toPreviewDependencies(dependencies: ResolvedDependency[], includeConfiguration: boolean): PreviewDependency[] {
  const previewDependencies = new Map<string, PreviewDependency>();
  for (const dependency of dependencies) {
    const key = `${dependency.kind}\0${fileNameKey(dependency.fileName)}`;
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
  fileExists: fileName => fs.existsSync(fileName)
};
