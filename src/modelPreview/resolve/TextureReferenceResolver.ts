import type { PreviewMaterial, PreviewRange } from "../ir/PreviewDocument";
import { lm } from "../../i18n/messages";
import type {
  ModelPreviewConfiguration,
  ModelPreviewFileSystem,
  RawTextureValue,
  ResolvedDependency,
  ResolvedModel
} from "../model/ModelDocument";
import { isTextureObject } from "../model/ModelDocument";
import { ModelIssueCollector } from "../model/ModelIssues";
import { normalizePathKey } from "../../../packages/mc-assets/src";
import { fileUriString } from "../paths";
import { resolveTextureFileName } from "./ResourceDependencyResolver";

export interface TextureMaterialResolution {
  material: PreviewMaterial;
  dependencies: ResolvedDependency[];
  textureFileName?: string;
}

export class TextureReferenceResolver {
  private readonly materials = new Map<string, TextureMaterialResolution>();

  constructor(
    private readonly model: ResolvedModel,
    private readonly fileSystem: ModelPreviewFileSystem,
    private readonly configuration: ModelPreviewConfiguration,
    private readonly issues: ModelIssueCollector
  ) { }

  resolve(textureReference: string, sourceModelFileName: string, referenceRange?: PreviewRange): TextureMaterialResolution {
    const cacheKey = `${sourceModelFileName}\0${textureReference}`;
    const cached = this.materials.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = this.resolveUncached(textureReference, sourceModelFileName, new Set<string>(), false, referenceRange);
    this.materials.set(cacheKey, result);
    return result;
  }

  allMaterials(): PreviewMaterial[] {
    const materials = new Map<string, PreviewMaterial>();
    for (const resolution of this.materials.values()) {
      materials.set(resolution.material.id, resolution.material);
    }
    return [...materials.values()];
  }

  allDependencies(): ResolvedDependency[] {
    const dependencies = new Map<string, ResolvedDependency>();
    for (const resolution of this.materials.values()) {
      for (const dependency of resolution.dependencies) {
        dependencies.set(`${dependency.kind}\0${normalizePathKey(dependency.fileName)}`, dependency);
      }
    }
    return [...dependencies.values()];
  }

  private resolveUncached(
    textureReference: string,
    sourceModelFileName: string,
    visitedSlots: Set<string>,
    forceTranslucent: boolean,
    referenceRange?: PreviewRange
  ): TextureMaterialResolution {
    if (!textureReference.startsWith("#")) {
      return this.resolveTextureFile(textureReference, sourceModelFileName, forceTranslucent, referenceRange);
    }

    const slotName = textureReference.slice(1);
    if (visitedSlots.has(slotName)) {
      this.issues.warning(lm("Texture variable cycle detected: {0}", textureReference), sourceModelFileName, referenceRange);
      return missingMaterial(textureReference);
    }

    const slot = this.model.textures[slotName];
    if (!slot) {
      this.issues.warning(lm("Texture variable not found: {0}", textureReference), sourceModelFileName, referenceRange);
      return missingMaterial(textureReference);
    }

    visitedSlots.add(slotName);
    return this.resolveTextureValue(slot.value, slot.sourceModelFileName, visitedSlots, forceTranslucent, slot.valueRange ?? referenceRange);
  }

  private resolveTextureValue(
    value: RawTextureValue,
    sourceModelFileName: string,
    visitedSlots: Set<string>,
    inheritedForceTranslucent: boolean,
    valueRange?: PreviewRange
  ): TextureMaterialResolution {
    if (typeof value === "string") {
      return this.resolveUncached(value, sourceModelFileName, visitedSlots, inheritedForceTranslucent, valueRange);
    }

    if (!isTextureObject(value) || !value.sprite) {
      this.issues.warning(lm("Texture object is missing sprite"), sourceModelFileName, valueRange);
      return missingMaterial("missing-object-sprite");
    }

    return this.resolveUncached(value.sprite, sourceModelFileName, visitedSlots, inheritedForceTranslucent || value.forceTranslucent === true, valueRange);
  }

  private resolveTextureFile(
    textureResource: string,
    sourceModelFileName: string,
    forceTranslucent: boolean,
    referenceRange?: PreviewRange
  ): TextureMaterialResolution {
    const textureFile = resolveTextureFileName(textureResource, sourceModelFileName, this.fileSystem, this.configuration);
    if (!textureFile) {
      this.issues.warning(lm("Texture not found: {0}", textureResource), sourceModelFileName, referenceRange);
      return missingMaterial(textureResource);
    }

    const dependencies: ResolvedDependency[] = [{ fileName: textureFile.fileName, kind: "texture" }];
    const metadataFileName = `${textureFile.fileName}.mcmeta`;
    if (this.fileSystem.fileExists(metadataFileName)) {
      dependencies.push({ fileName: metadataFileName, kind: "textureMetadata" });
      this.issues.info(lm("Animated texture metadata is detected; MVP previews the first loaded PNG frame"), metadataFileName);
    }

    const normalizedKey = normalizePathKey(textureFile.fileName);
    return {
      material: {
        id: `texture:${normalizedKey}`,
        textureUri: fileUriString(textureFile.fileName),
        fallback: "texture",
        transparent: forceTranslucent
      },
      dependencies,
      textureFileName: textureFile.fileName
    };
  }
}

function missingMaterial(textureReference: string): TextureMaterialResolution {
  return {
    material: {
      id: `missing:${textureReference}`,
      fallback: "missing",
      transparent: false
    },
    dependencies: []
  };
}
