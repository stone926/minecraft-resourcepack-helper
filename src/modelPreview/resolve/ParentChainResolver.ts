import type {
  ModelPreviewConfiguration,
  ModelPreviewFileSystem,
  RawElementRotation,
  RawFaceName,
  RawFace,
  RawModelData,
  RawModelDocument,
  ResolvedDependency,
  ResolvedElement,
  ResolvedModel,
  ResolvedTextureSlot
} from "../model/ModelDocument";
import { lm } from "../../i18n/messages";
import { ModelIssueCollector } from "../model/ModelIssues";
import { collectModelJsonLocations } from "../model/ModelJsonLocations";
import { throwIfCancellationRequested, type ModelPreviewCancellationToken } from "../cancellation";
import { normalizePathKey, type ResourceFileRequest } from "../../../packages/mc-assets/src";
import { createFileSystemModelLoader, type ParentChainModelLoader } from "./RawModelLoader";
import { ResourceDependencyResolver, modelResourceIdFromFileName } from "./ResourceDependencyResolver";
import { normalizeDisplayTransforms, normalizePartialDisplayTransforms } from "./TransformNormalizer";
import { TextOffsetMap } from "../../utils/textOffsets";
import { maxModelParentDepth, ModelParentTraversal } from "../../services/modelParentTraversal";

const generatedParents = new Set(["item/generated", "minecraft:item/generated", "builtin/generated", "minecraft:builtin/generated"]);

interface LoadedModelNode {
  document: RawModelDocument;
  resourceId: string;
}

export interface RawModelDocumentCache {
  getRawModel(fileName: string, version: string | null): Promise<RawModelDocument> | null;
  setRawModel(fileName: string, version: string | null, document: Promise<RawModelDocument>): void;
}

export class ParentChainResolver {
  private readonly resolutionDependencies = new Map<string, ResolvedDependency>();
  private readonly resources: ResourceDependencyResolver;

  constructor(
    private readonly fileSystem: ModelPreviewFileSystem,
    private readonly configuration: ModelPreviewConfiguration,
    private readonly issues: ModelIssueCollector,
    private readonly cancellationToken?: ModelPreviewCancellationToken,
    private readonly rawModelCache?: RawModelDocumentCache,
    private readonly observeDependency?: (fileName: string) => void,
    private readonly modelLoader: ParentChainModelLoader = createFileSystemModelLoader(fileSystem),
    resolveResourcePath?: (request: ResourceFileRequest) => string | null
  ) {
    this.resources = new ResourceDependencyResolver(fileSystem, configuration, observeDependency, resolveResourcePath);
  }

  async resolve(entryFileName: string): Promise<ResolvedModel | null> {
    throwIfCancellationRequested(this.cancellationToken);
    const chain = await this.loadParentChain(entryFileName);
    throwIfCancellationRequested(this.cancellationToken);
    if (chain.length === 0) {
      return null;
    }

    const entry = chain[chain.length - 1];
    return this.mergeChain(chain, entry.document.fileName, entry.resourceId);
  }

  private async loadParentChain(entryFileName: string): Promise<LoadedModelNode[]> {
    const childToParent: LoadedModelNode[] = [];
    const traversal = new ModelParentTraversal(entryFileName);
    let fileName = entryFileName;

    while (true) {
      throwIfCancellationRequested(this.cancellationToken);
      const document = await this.loadRawModel(fileName);
      throwIfCancellationRequested(this.cancellationToken);
      childToParent.push({ document, resourceId: modelResourceIdFromFileName(fileName) });
      const parent = document.data?.parent;
      if (!parent || generatedParents.has(parent)) {
        break;
      }

      for (const candidate of this.resources.getModelFileCandidates(parent, fileName)) {
        this.resolutionDependencies.set(normalizePathKey(candidate), {
          fileName: candidate,
          kind: "model",
          watchOnly: true
        });
      }
      const parentFile = this.resources.resolveModelFileName(parent, fileName);
      if (!parentFile) {
        this.issues.warning(lm("Parent model not found: {0}", parent), fileName, document.data?.parentRange);
        break;
      }

      const advance = traversal.advance(parentFile.fileName);
      if (advance.kind === "cycle") {
        this.issues.error(lm("Parent model cycle detected"), advance.fileName);
        break;
      }
      if (advance.kind === "depth") {
        this.issues.error(lm("Parent model depth exceeds {0}", maxModelParentDepth), advance.fileName);
        break;
      }
      fileName = advance.fileName;
    }

    return childToParent.reverse();
  }

  private async loadRawModel(fileName: string): Promise<RawModelDocument> {
    throwIfCancellationRequested(this.cancellationToken);
    this.observeDependency?.(fileName);
    const version = this.fileSystem.fileVersion?.(fileName) ?? null;
    const cached = this.rawModelCache?.getRawModel(fileName, version);
    if (cached) {
      return cached;
    }

    const document = await this.loadRawModelUncached(fileName);
    if (document.data) {
      this.rawModelCache?.setRawModel(fileName, version, Promise.resolve(document));
    }
    return document;
  }

  private async loadRawModelUncached(fileName: string): Promise<RawModelDocument> {
    let text: string;
    try {
      text = await this.modelLoader.readModelText(fileName);
    } catch {
      this.issues.error(lm("Model JSON could not be read"), fileName);
      return { fileName, text: "", data: null };
    }

    throwIfCancellationRequested(this.cancellationToken);
    try {
      const rawValue = await this.modelLoader.parseModelValue(fileName, text);
      const locations = collectModelJsonLocations(text);
      return {
        fileName,
        text,
        data: normalizeRawModel(rawValue, locations),
        locations
      };
    } catch (error) {
      this.issues.error(lm("Model JSON could not be parsed"), fileName, rangeFromJsonParseError(text, error));
      return { fileName, text, data: null };
    }
  }

  private mergeChain(chain: LoadedModelNode[], entryFileName: string, resourceId: string): ResolvedModel {
    const textures = new Map<string, ResolvedTextureSlot>();
    const dependencies: ResolvedDependency[] = chain.map(node => ({
      fileName: node.document.fileName,
      kind: "model" as const
    }));
    dependencies.push(...this.resolutionDependencies.values());
    let elements: ResolvedElement[] = [];
    let display: ResolvedModel["display"] = {};
    let generatedItem = false;
    let parent: string | undefined;

    for (const node of chain) {
      const data = node.document.data;
      if (!data) {
        continue;
      }

      if (data.parent) {
        parent = data.parent;
        if (generatedParents.has(data.parent)) {
          generatedItem = true;
        }
      }

      for (const [name, value] of Object.entries(data.textures ?? {})) {
        textures.set(name, {
          name,
          value,
          sourceModelFileName: node.document.fileName,
          valueRange: data.textureRanges?.[name]
        });
      }

      if (data.display) {
        display = mergeDisplay(display, data.display);
      }

      if (Array.isArray(data.elements)) {
        elements = data.elements.map((element, index) => ({
          element,
          index,
          sourceModelFileName: node.document.fileName
        }));
        generatedItem = false;
      }
    }

    return {
      fileName: entryFileName,
      resourceId,
      parent,
      generatedItem,
      textures: Object.fromEntries(textures),
      elements,
      display: normalizeDisplayTransforms(display),
      dependencies
    };
  }
}

function normalizeRawModel(value: unknown, locations = collectModelJsonLocations("")): RawModelData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    parent: typeof record.parent === "string" ? record.parent : undefined,
    parentRange: locations.parent,
    textures: normalizeTextures(record.textures),
    textureRanges: locations.textures,
    elements: normalizeElements(record.elements, locations),
    display: normalizePartialDisplayTransforms(record.display)
  };
}

function normalizeTextures(value: unknown): RawModelData["textures"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const textures: NonNullable<RawModelData["textures"]> = {};
  for (const [name, texture] of Object.entries(value as Record<string, unknown>)) {
    if (typeof texture === "string") {
      textures[name] = texture;
    } else if (texture && typeof texture === "object" && !Array.isArray(texture)) {
      const textureObject = texture as Record<string, unknown>;
      textures[name] = {
        sprite: typeof textureObject.sprite === "string" ? textureObject.sprite : undefined,
        forceTranslucent: typeof textureObject.force_translucent === "boolean" ? textureObject.force_translucent : undefined
      };
    }
  }

  return textures;
}

function normalizeElements(value: unknown, locations: ReturnType<typeof collectModelJsonLocations>): RawModelData["elements"] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .filter((element): element is Record<string, unknown> => element !== null && typeof element === "object" && !Array.isArray(element))
    .map((element, index) => ({
      from: normalizeVec3(element.from),
      fromRange: locations.elements[index]?.from,
      to: normalizeVec3(element.to),
      toRange: locations.elements[index]?.to,
      range: locations.elements[index]?.range,
      rotation: normalizeElementRotation(element.rotation, locations.elements[index]),
      shade: typeof element.shade === "boolean" ? element.shade : undefined,
      lightEmission: typeof element.light_emission === "number" ? element.light_emission : undefined,
      faces: normalizeFaces(element.faces, locations.elements[index])
    }));
}

function normalizeElementRotation(value: unknown, locations?: ReturnType<typeof collectModelJsonLocations>["elements"][number]): RawElementRotation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const axis = record.axis;
  return {
    origin: normalizeVec3(record.origin),
    axis: axis === "x" || axis === "y" || axis === "z" ? axis : undefined,
    angle: numberValue(record.angle),
    x: numberValue(record.x),
    y: numberValue(record.y),
    z: numberValue(record.z),
    rescale: typeof record.rescale === "boolean" ? record.rescale : undefined,
    rescaleRange: locations?.rotationRescale
  };
}

function normalizeFaces(value: unknown, locations?: ReturnType<typeof collectModelJsonLocations>["elements"][number]): Partial<Record<RawFaceName, RawFace>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const faces: NonNullable<NonNullable<RawModelData["elements"]>[number]["faces"]> = {};
  for (const direction of ["down", "up", "north", "south", "west", "east"] as const) {
    const rawFace = (value as Record<string, unknown>)[direction];
    if (!rawFace || typeof rawFace !== "object" || Array.isArray(rawFace)) {
      continue;
    }

    const face = rawFace as Record<string, unknown>;
    faces[direction] = {
      range: locations?.faces[direction]?.range,
      uv: normalizeUv(face.uv),
      uvRange: locations?.faces[direction]?.uv,
      texture: typeof face.texture === "string" ? face.texture : undefined,
      textureRange: locations?.faces[direction]?.texture,
      rotation: numberValue(face.rotation),
      cullface: typeof face.cullface === "string" ? face.cullface : undefined,
      tintindex: typeof face.tintindex === "number" ? face.tintindex : undefined
    };
  }

  return faces;
}

function mergeDisplay(
  base: Record<string, ReturnType<typeof normalizeDisplayTransforms>[string]>,
  overrides: Record<string, Partial<ReturnType<typeof normalizeDisplayTransforms>[string]>>
): ReturnType<typeof normalizeDisplayTransforms> {
  return normalizeDisplayTransforms({
    ...base,
    ...overrides
  });
}

function normalizeVec3(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 3) {
    return undefined;
  }

  const vector = value.slice(0, 3).map(numberValue);
  if (!vector.every((item): item is number => item !== undefined)) {
    return undefined;
  }

  return [vector[0], vector[1], vector[2]];
}

function normalizeUv(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 4) {
    return undefined;
  }

  const vector = value.slice(0, 4).map(numberValue);
  if (!vector.every((item): item is number => item !== undefined)) {
    return undefined;
  }

  return [vector[0], vector[1], vector[2], vector[3]];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rangeFromJsonParseError(text: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\bposition\s+(\d+)\b/i.exec(message);
  const offset = match ? Math.max(0, Math.min(text.length, Number(match[1]))) : text.length;
  const { line, character } = new TextOffsetMap(text).positionAt(offset);

  return {
    start: { line, character },
    end: { line, character: character + 1 }
  };
}
