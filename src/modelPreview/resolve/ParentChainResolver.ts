import type {
  ModelPreviewConfiguration,
  ModelPreviewFileSystem,
  RawElementRotation,
  RawFaceName,
  RawFace,
  RawModelData,
  RawModelDocument,
  ResolvedElement,
  ResolvedModel,
  ResolvedTextureSlot
} from "../model/ModelDocument";
import { ModelIssueCollector } from "../model/ModelIssues";
import { fileNameKey, modelResourceIdFromFileName, resolveModelFileName } from "./ResourceDependencyResolver";
import { normalizeDisplayTransforms, normalizePartialDisplayTransforms } from "./TransformNormalizer";

const maxParentDepth = 10;
const generatedParents = new Set(["item/generated", "minecraft:item/generated", "builtin/generated", "minecraft:builtin/generated"]);

interface LoadedModelNode {
  document: RawModelDocument;
  resourceId: string;
}

export class ParentChainResolver {
  constructor(
    private readonly fileSystem: ModelPreviewFileSystem,
    private readonly configuration: ModelPreviewConfiguration,
    private readonly issues: ModelIssueCollector
  ) { }

  async resolve(entryFileName: string): Promise<ResolvedModel | null> {
    const chain = await this.loadParentChain(entryFileName, new Set<string>(), 0);
    if (chain.length === 0) {
      return null;
    }

    const entry = chain[chain.length - 1];
    return this.mergeChain(chain, entry.document.fileName, entry.resourceId);
  }

  private async loadParentChain(fileName: string, visited: Set<string>, depth: number): Promise<LoadedModelNode[]> {
    const key = fileNameKey(fileName);
    if (visited.has(key)) {
      this.issues.error("Parent model cycle detected", fileName);
      return [];
    }

    if (depth > maxParentDepth) {
      this.issues.error(`Parent model depth exceeds ${maxParentDepth}`, fileName);
      return [];
    }

    visited.add(key);
    const document = await this.loadRawModel(fileName);
    if (!document.data) {
      return [{
        document,
        resourceId: modelResourceIdFromFileName(fileName)
      }];
    }

    const parent = document.data.parent;
    const node = {
      document,
      resourceId: modelResourceIdFromFileName(fileName)
    };

    if (!parent || generatedParents.has(parent)) {
      return [node];
    }

    const parentFile = resolveModelFileName(parent, fileName, this.fileSystem, this.configuration);
    if (!parentFile) {
      this.issues.warning(`Parent model not found: ${parent}`, fileName);
      return [node];
    }

    const parentChain = await this.loadParentChain(parentFile.fileName, visited, depth + 1);
    return [...parentChain, node];
  }

  private async loadRawModel(fileName: string): Promise<RawModelDocument> {
    let text: string;
    try {
      text = await this.fileSystem.readTextFile(fileName);
    } catch {
      this.issues.error("Model JSON could not be read", fileName);
      return { fileName, text: "", data: null };
    }

    try {
      return {
        fileName,
        text,
        data: normalizeRawModel(JSON.parse(text) as unknown)
      };
    } catch {
      this.issues.error("Model JSON could not be parsed", fileName);
      return { fileName, text, data: null };
    }
  }

  private mergeChain(chain: LoadedModelNode[], entryFileName: string, resourceId: string): ResolvedModel {
    const textures = new Map<string, ResolvedTextureSlot>();
    const dependencies = chain.map(node => ({
      fileName: node.document.fileName,
      kind: "model" as const
    }));
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
          sourceModelFileName: node.document.fileName
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

function normalizeRawModel(value: unknown): RawModelData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    parent: typeof record.parent === "string" ? record.parent : undefined,
    textures: normalizeTextures(record.textures),
    elements: normalizeElements(record.elements),
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
        force_translucent: typeof textureObject.force_translucent === "boolean" ? textureObject.force_translucent : undefined
      };
    }
  }

  return textures;
}

function normalizeElements(value: unknown): RawModelData["elements"] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .filter((element): element is Record<string, unknown> => element !== null && typeof element === "object" && !Array.isArray(element))
    .map(element => ({
      from: normalizeVec3(element.from),
      to: normalizeVec3(element.to),
      rotation: normalizeElementRotation(element.rotation),
      shade: typeof element.shade === "boolean" ? element.shade : undefined,
      light_emission: typeof element.light_emission === "number" ? element.light_emission : undefined,
      faces: normalizeFaces(element.faces)
    }));
}

function normalizeElementRotation(value: unknown): RawElementRotation | undefined {
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
    rescale: typeof record.rescale === "boolean" ? record.rescale : undefined
  };
}

function normalizeFaces(value: unknown): Partial<Record<RawFaceName, RawFace>> | undefined {
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
      uv: normalizeUv(face.uv),
      texture: typeof face.texture === "string" ? face.texture : undefined,
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
    ...Object.fromEntries(Object.entries(overrides).map(([name, transform]) => [
      name,
      {
        ...base[name],
        ...transform
      }
    ]))
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
