import * as path from "node:path";
import { lm } from "../../i18n/messages";
import { resolveCitAsset } from "../../cit/citAssetResolver";
import { resolveCitKeyForType, resolveCitType } from "../../cit/citKeyResolution";
import { parseCitProperties, type CitPropertyEntry } from "../../cit/citPropertiesParser";
import type { CitAssetKind, CitType } from "../../cit/citSpecTypes";
import type { ModelPreviewFileSystem, ResolvedModel } from "../model/ModelDocument";
import { ModelIssueCollector } from "../model/ModelIssues";
import { throwIfCancellationRequested, type ModelPreviewCancellationToken } from "../cancellation";

export class CitPreviewResolver {
  constructor(
    private readonly fileSystem: ModelPreviewFileSystem,
    private readonly issues: ModelIssueCollector,
    private readonly resolveReferencedModel: (fileName: string) => Promise<ResolvedModel | null>,
    private readonly cancellationToken?: ModelPreviewCancellationToken
  ) { }

  async resolve(fileName: string): Promise<ResolvedModel | null> {
    // CIT preview is intentionally an asset preview. It resolves the primary
    // model/texture enough for authoring feedback, but does not emulate runtime
    // condition matching, item-state submodels, glint layers, or equipment-layer
    // selection.
    let text: string;
    try {
      text = await this.fileSystem.readTextFile(fileName);
    } catch {
      this.issues.error(lm("CIT properties could not be read"), fileName);
      return null;
    }

    throwIfCancellationRequested(this.cancellationToken);
    const entries = parseCitProperties(text);
    const citType = resolveCitType(entries);
    if (citType === "item") {
      return this.resolveItemModel(fileName, entries);
    }

    const textureEntry = findPreviewTextureEntry(entries, citType);
    if (!textureEntry) {
      this.issues.warning(lm("CIT preview requires a texture property"), fileName);
      return null;
    }

    if (citType === "enchantment") {
      const blend = entries.find(entry => entry.key === "blend")?.value;
      if (blend) {
        this.issues.info(lm("CIT enchantment preview approximates blend mode: {0}", blend), fileName, toPreviewRange(textureEntry.valueRange));
      }
    }

    return createGeneratedCitModel(fileName, textureEntry.value, `cit-${citType}`);
  }

  private async resolveItemModel(fileName: string, entries: CitPropertyEntry[]): Promise<ResolvedModel | null> {
    const modelEntry = findCanonicalAssetEntry(entries, "item", "model", "model");
    const textureEntry = findCanonicalAssetEntry(entries, "item", "texture", "texture");
    const resolutionHost = {
      pathExists: (candidate: string) => this.fileSystem.fileExists(candidate),
      getPackRoot: this.fileSystem.getPackRoot
        ? (sourceFileName: string) => this.fileSystem.getPackRoot?.(sourceFileName) ?? null
        : undefined
    };
    const explicitModel = modelEntry
      ? resolveCitAsset(fileName, modelEntry.value, "models", resolutionHost)
      : null;
    const autoModel = !modelEntry && !textureEntry
      ? resolveCitAsset(fileName, path.basename(fileName, path.extname(fileName)), "models", resolutionHost)
      : null;
    const modelFileName = explicitModel ?? autoModel;

    if (modelFileName) {
      const model = await this.resolveReferencedModel(modelFileName);
      if (!model) {
        return null;
      }
      if (textureEntry) {
        return overrideModelTextures(model, fileName, textureEntry.value);
      }
      return model;
    }

    if (modelEntry && !explicitModel) {
      this.issues.warning(lm("CIT model not found: {0}", modelEntry.value), fileName, toPreviewRange(modelEntry.valueRange));
    }

    const textureValue = textureEntry?.value ?? (
      !modelEntry ? path.basename(fileName, path.extname(fileName)) : null
    );
    if (!textureValue) {
      this.issues.warning(lm("CIT preview requires model or texture"), fileName);
      return null;
    }

    return createGeneratedCitModel(fileName, textureValue, "cit-item");
  }
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

function findPreviewTextureEntry(
  entries: CitPropertyEntry[],
  citType: Exclude<CitType, "item">
): CitPropertyEntry | null {
  if (citType === "armor") {
    return entries.find(entry => {
      const resolution = resolveCitKeyForType(entry.key, citType);
      return resolution?.assetKind === "texture" && resolution.canonicalKey.startsWith("texture.");
    }) ?? null;
  }

  return findCanonicalAssetEntry(entries, citType, "texture", "texture");
}

function findCanonicalAssetEntry(
  entries: CitPropertyEntry[],
  citType: CitType,
  canonicalKey: string,
  assetKind: CitAssetKind
): CitPropertyEntry | null {
  return entries.find(entry => {
    const resolution = resolveCitKeyForType(entry.key, citType);
    return resolution?.canonicalKey === canonicalKey && resolution.assetKind === assetKind;
  }) ?? null;
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
