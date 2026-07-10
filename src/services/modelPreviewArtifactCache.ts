import type { PngAlphaMask } from "../modelPreview/bake/AlphaMask";
import type { RawModelDocument, ResolvedModel } from "../modelPreview/model/ModelDocument";
import type { MediaMetadataCache } from "./mediaMetadataCache";
import type { ModelResourceCache } from "./modelResourceCache";

export class ModelPreviewArtifactCache {
  constructor(
    private readonly models: ModelResourceCache,
    private readonly mediaMetadata: MediaMetadataCache
  ) {}

  getRawModel(fileName: string, version: string | null): Promise<RawModelDocument> | null {
    return this.models.getPreviewRawModel(fileName, version);
  }

  setRawModel(fileName: string, version: string | null, document: Promise<RawModelDocument>): void {
    this.models.setPreviewRawModel(fileName, version, document);
  }

  getResolvedModel(
    fileName: string,
    configurationKey: string,
    getVersion: (fileName: string) => string | null
  ): Promise<ResolvedModel | null> | null {
    return this.models.getPreviewResolvedModel(fileName, configurationKey, getVersion);
  }

  setResolvedModel(
    fileName: string,
    configurationKey: string,
    model: Promise<ResolvedModel | null>,
    getVersion: (fileName: string) => string | null
  ): void {
    this.models.setPreviewResolvedModel(fileName, configurationKey, model, getVersion);
  }

  getTextureAlphaMask(fileName: string, version: string | null): Promise<PngAlphaMask | null> | null {
    return this.mediaMetadata.getTextureAlphaMask(fileName, version);
  }

  setTextureAlphaMask(
    fileName: string,
    version: string | null,
    alphaMask: Promise<PngAlphaMask | null>
  ): void {
    this.mediaMetadata.setTextureAlphaMask(fileName, version, alphaMask);
  }

  invalidateDependents(fileName: string): void {
    this.models.invalidatePreviewDependents(fileName);
    this.mediaMetadata.invalidatePath(fileName);
  }

  invalidateAll(): void {
    this.models.invalidatePreviewArtifacts();
    this.mediaMetadata.invalidateTextureAlphaMasks();
  }

  getStats(): Record<string, number> {
    const modelSizes = this.models.getSizes();
    const mediaSizes = this.mediaMetadata.getSizes();
    return {
      rawModels: modelSizes.rawModels,
      resolvedModels: modelSizes.resolvedModels,
      textureAlphaMasks: mediaSizes.textureAlphaMasks
    };
  }
}
