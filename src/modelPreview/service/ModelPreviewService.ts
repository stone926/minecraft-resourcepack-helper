import * as fs from "node:fs";
import * as path from "node:path";
import { lm } from "../../i18n/messages";
import { getCitPathCandidates, isCitPropertiesFileName, type CitResourceType } from "../../utils/citPaths";
import { parseCitProperties, type CitPropertyEntry } from "../../utils/citPropertiesParser";
import type { ModelPreviewDocument, PreviewDependency } from "../ir/PreviewDocument";
import type { ModelPreviewConfiguration, ModelPreviewFileSystem, ResolvedDependency, ResolvedModel } from "../model/ModelDocument";
import { ModelIssueCollector } from "../model/ModelIssues";
import { CuboidBaker } from "../bake/CuboidBaker";
import { createGeneratedItemElements } from "../bake/GeneratedItemModel";
import { readPngAlphaMask, type PngAlphaMask } from "../bake/PngAlpha";
import { ParentChainResolver } from "../resolve/ParentChainResolver";
import { fileNameKey, fileUriString } from "../resolve/ResourceDependencyResolver";
import { TextureReferenceResolver } from "../resolve/TextureReferenceResolver";
import { ModelPreviewCache } from "./ModelPreviewCache";
import {
  isCancellationError,
  throwIfCancellationRequested,
  type ModelPreviewCancellationToken
} from "./ModelPreviewCancellation";

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
          this.fileSystem,
          issues,
          cancellationToken,
          (textureFileName, targetIssues, token) => this.readTextureAlphaMask(textureFileName, targetIssues, token)
        )
      };
    }
    throwIfCancellationRequested(cancellationToken);

    const baker = new CuboidBaker(textureResolver, issues, cancellationToken);
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

  private async resolveCitPreviewModel(
    fileName: string,
    configuration: ModelPreviewConfiguration,
    issues: ModelIssueCollector,
    cancellationToken?: ModelPreviewCancellationToken
  ): Promise<ResolvedModel | null> {
    let text: string;
    try {
      text = await this.fileSystem.readTextFile(fileName);
    } catch {
      issues.error(lm("CIT properties could not be read"), fileName);
      return null;
    }

    throwIfCancellationRequested(cancellationToken);
    const entries = parseCitProperties(text);
    const citType = getCitType(entries);
    if (citType === "item") {
      return this.resolveItemCitPreviewModel(fileName, entries, configuration, issues, cancellationToken);
    }

    const textureEntry = findPreviewTextureEntry(entries, citType);
    if (!textureEntry) {
      issues.warning(lm("CIT preview requires a texture property"), fileName);
      return null;
    }

    if (citType === "enchantment") {
      const blend = entries.find(entry => entry.key === "blend")?.value;
      if (blend) {
        issues.info(lm("CIT enchantment preview approximates blend mode: {0}", blend), fileName, toPreviewRange(textureEntry.valueRange));
      }
    }

    return createGeneratedCitModel(fileName, textureEntry.value, `cit-${citType}`);
  }

  private async resolveItemCitPreviewModel(
    fileName: string,
    entries: CitPropertyEntry[],
    configuration: ModelPreviewConfiguration,
    issues: ModelIssueCollector,
    cancellationToken?: ModelPreviewCancellationToken
  ): Promise<ResolvedModel | null> {
    const modelEntry = entries.find(entry => entry.key === "model");
    const textureEntry = entries.find(entry => entry.key === "texture");
    const explicitModel = modelEntry ? resolveCitAsset(fileName, modelEntry.value, "models", this.fileSystem) : null;
    const autoModel = !modelEntry && !textureEntry ? resolveCitAsset(fileName, path.basename(fileName, path.extname(fileName)), "models", this.fileSystem) : null;
    const modelFileName = explicitModel ?? autoModel;

    if (modelFileName) {
      const model = await this.resolveModel(modelFileName, configuration, issues, cancellationToken);
      if (!model) {
        return null;
      }
      if (textureEntry) {
        return overrideModelTextures(model, fileName, textureEntry.value);
      }
      return model;
    }

    if (modelEntry && !explicitModel) {
      issues.warning(lm("CIT model not found: {0}", modelEntry.value), fileName, toPreviewRange(modelEntry.valueRange));
    }

    const textureValue = textureEntry?.value ?? (
      !modelEntry ? path.basename(fileName, path.extname(fileName)) : null
    );
    if (!textureValue) {
      issues.warning(lm("CIT preview requires model or texture"), fileName);
      return null;
    }

    return createGeneratedCitModel(fileName, textureValue, "cit-item");
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
      const alphaMask = readPngAlphaMask(bytes);
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

function createGeneratedCitModel(fileName: string, texture: string, resourceId: string): ResolvedModel {
  return {
    fileName,
    resourceId,
    parent: "minecraft:item/generated",
    generatedItem: true,
    textures: {
      layer0: {
        name: "layer0",
        value: texture,
        sourceModelFileName: fileName
      }
    },
    elements: [],
    display: {},
    dependencies: [{ fileName, kind: "model" }]
  };
}

function overrideModelTextures(model: ResolvedModel, sourceModelFileName: string, texture: string): ResolvedModel {
  const textures = Object.fromEntries(Object.keys(model.textures).map(name => [
    name,
    {
      name,
      value: texture,
      sourceModelFileName
    }
  ]));

  if (Object.keys(textures).length === 0) {
    textures.layer0 = {
      name: "layer0",
      value: texture,
      sourceModelFileName
    };
  }

  return {
    ...model,
    textures
  };
}

function resolveCitAsset(
  sourceFileName: string,
  value: string,
  resourceType: CitResourceType,
  fileSystem: ModelPreviewFileSystem
): string | null {
  const packRoot = fileSystem.getPackRoot?.(sourceFileName) ?? getPackRootFromAssetsPath(sourceFileName);
  if (!packRoot) {
    return null;
  }

  for (const candidate of getCitPathCandidates(sourceFileName, packRoot, value, resourceType)) {
    if (fileSystem.fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getCitType(entries: CitPropertyEntry[]): "item" | "armor" | "elytra" | "enchantment" {
  const value = entries.find(entry => entry.key === "type")?.value.trim();
  return value === "armor" || value === "elytra" || value === "enchantment" ? value : "item";
}

function findPreviewTextureEntry(
  entries: CitPropertyEntry[],
  citType: "armor" | "elytra" | "enchantment"
): CitPropertyEntry | null {
  if (citType === "armor") {
    return entries.find(entry => entry.key.startsWith("texture.")) ?? null;
  }

  return entries.find(entry => entry.key === "texture") ?? null;
}

function toPreviewRange(location: CitPropertyEntry["valueRange"]) {
  return {
    start: {
      line: location.start.line - 1,
      character: location.start.column
    },
    end: {
      line: location.end.line - 1,
      character: location.end.column
    }
  };
}

function getPackRootFromAssetsPath(fileName: string): string | null {
  const normalizedPath = path.normalize(fileName);
  const parsedPath = path.parse(normalizedPath);
  const segments = path.relative(parsedPath.root, normalizedPath).split(path.sep).filter(Boolean);
  const assetsIndex = findLastIndex(segments, segment => segment.toLowerCase() === "assets");
  if (assetsIndex < 0) {
    return null;
  }

  return path.join(parsedPath.root, ...segments.slice(0, assetsIndex));
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

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (predicate(values[index])) {
      return index;
    }
  }

  return -1;
}
