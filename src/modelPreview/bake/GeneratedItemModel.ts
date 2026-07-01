import type { PreviewDirection, PreviewVec3 } from "../ir/PreviewDocument";
import { lm } from "../../i18n/messages";
import type { ModelPreviewFileSystem, RawElement, RawFace, ResolvedElement, ResolvedModel } from "../model/ModelDocument";
import { ModelIssueCollector } from "../model/ModelIssues";
import { TextureReferenceResolver } from "../resolve/TextureReferenceResolver";
import { throwIfCancellationRequested, type ModelPreviewCancellationToken } from "../service/ModelPreviewCancellation";
import { readPngAlphaMask, type PngAlphaMask } from "./PngAlpha";

const itemLayers = ["layer0", "layer1", "layer2", "layer3", "layer4"];
const minZ = 7.5;
const maxZ = 8.5;
const uvShrink = 0.1;
const fallbackSpriteSize = 16;

interface GeneratedLayer {
  textureReference: string;
  tintindex: number;
  alphaMask: PngAlphaMask | null;
}

interface SideFace {
  side: SideDirection;
  x: number;
  y: number;
}

type SideDirection = "up" | "down" | "left" | "right";

type TextureAlphaReader = (
  fileName: string,
  issues: ModelIssueCollector,
  token?: ModelPreviewCancellationToken
) => Promise<PngAlphaMask | null>;

export async function createGeneratedItemElements(
  model: ResolvedModel,
  textureResolver: TextureReferenceResolver,
  fileSystem: ModelPreviewFileSystem,
  issues: ModelIssueCollector,
  cancellationToken?: ModelPreviewCancellationToken,
  readTextureAlpha?: TextureAlphaReader
): Promise<ResolvedElement[]> {
  const layers = await resolveGeneratedLayers(model, textureResolver, fileSystem, issues, cancellationToken, readTextureAlpha);
  const elements: ResolvedElement[] = [];

  for (const layer of layers) {
    throwIfCancellationRequested(cancellationToken);
    for (const element of createLayerElements(layer)) {
      elements.push({
        element,
        index: elements.length,
        sourceModelFileName: model.fileName
      });
    }
  }

  return elements;
}

async function resolveGeneratedLayers(
  model: ResolvedModel,
  textureResolver: TextureReferenceResolver,
  fileSystem: ModelPreviewFileSystem,
  issues: ModelIssueCollector,
  cancellationToken?: ModelPreviewCancellationToken,
  readTextureAlpha: TextureAlphaReader = (fileName, targetIssues, token) => readTextureAlphaMask(fileSystem, fileName, targetIssues, token)
): Promise<GeneratedLayer[]> {
  const layers: GeneratedLayer[] = [];

  for (let layerIndex = 0; layerIndex < itemLayers.length; layerIndex++) {
    throwIfCancellationRequested(cancellationToken);
    const textureSlot = itemLayers[layerIndex];
    if (!model.textures[textureSlot]) {
      break;
    }

    const textureReference = `#${textureSlot}`;
    const resolution = textureResolver.resolve(textureReference, model.fileName, model.textures[textureSlot]?.valueRange);
    const alphaMask = resolution.textureFileName
      ? await readTextureAlpha(resolution.textureFileName, issues, cancellationToken)
      : null;

    layers.push({
      textureReference,
      tintindex: layerIndex,
      alphaMask
    });
  }

  return layers;
}

async function readTextureAlphaMask(
  fileSystem: ModelPreviewFileSystem,
  textureFileName: string,
  issues: ModelIssueCollector,
  cancellationToken?: ModelPreviewCancellationToken
): Promise<PngAlphaMask | null> {
  try {
    throwIfCancellationRequested(cancellationToken);
    const alphaMask = readPngAlphaMask(await fileSystem.readBinaryFile(textureFileName));
    throwIfCancellationRequested(cancellationToken);
    if (alphaMask) {
      return alphaMask;
    }
  } catch {
    // Fall through to the same approximation as an unsupported PNG layout.
  }

  issues.info(lm("Generated item side extrusion is approximated because texture pixels could not be decoded"), textureFileName);
  return null;
}

function createLayerElements(layer: GeneratedLayer): RawElement[] {
  return [
    createFrontBackElement(layer),
    ...createSideElements(layer)
  ];
}

function createFrontBackElement(layer: GeneratedLayer): RawElement {
  return {
    from: [0, 0, minZ],
    to: [16, 16, maxZ],
    faces: {
      south: createFace(layer, [0, 0, 16, 16]),
      north: createFace(layer, [16, 0, 0, 16])
    }
  };
}

function createSideElements(layer: GeneratedLayer): RawElement[] {
  const alphaMask = layer.alphaMask ?? createFallbackAlphaMask();
  const xScale = 16 / alphaMask.width;
  const yScale = 16 / alphaMask.height;
  return getSideFaces(alphaMask).map(sideFace => createSideElement(layer, sideFace, xScale, yScale));
}

function createFallbackAlphaMask(): PngAlphaMask {
  return {
    width: fallbackSpriteSize,
    height: fallbackSpriteSize,
    isOpaque: () => true
  };
}

function getSideFaces(alphaMask: PngAlphaMask): SideFace[] {
  const sideFaces: SideFace[] = [];

  for (let y = 0; y < alphaMask.height; y++) {
    for (let x = 0; x < alphaMask.width; x++) {
      if (!alphaMask.isOpaque(x, y)) {
        continue;
      }

      addSideFaceIfTransparent(sideFaces, alphaMask, "up", x, y, x, y - 1);
      addSideFaceIfTransparent(sideFaces, alphaMask, "down", x, y, x, y + 1);
      addSideFaceIfTransparent(sideFaces, alphaMask, "left", x, y, x - 1, y);
      addSideFaceIfTransparent(sideFaces, alphaMask, "right", x, y, x + 1, y);
    }
  }

  return sideFaces;
}

function addSideFaceIfTransparent(
  sideFaces: SideFace[],
  alphaMask: PngAlphaMask,
  side: SideDirection,
  x: number,
  y: number,
  neighborX: number,
  neighborY: number
): void {
  if (isTransparent(alphaMask, neighborX, neighborY)) {
    sideFaces.push({ side, x, y });
  }
}

function isTransparent(alphaMask: PngAlphaMask, x: number, y: number): boolean {
  return x < 0 || y < 0 || x >= alphaMask.width || y >= alphaMask.height || !alphaMask.isOpaque(x, y);
}

function createSideElement(layer: GeneratedLayer, sideFace: SideFace, xScale: number, yScale: number): RawElement {
  const { from, to, direction } = getSideGeometry(sideFace, xScale, yScale);
  return {
    from,
    to,
    faces: {
      [direction]: createFace(layer, getSideUv(sideFace, xScale, yScale))
    }
  };
}

function getSideGeometry(
  sideFace: SideFace,
  xScale: number,
  yScale: number
): { from: PreviewVec3; to: PreviewVec3; direction: PreviewDirection } {
  let startX = sideFace.x;
  let startY = sideFace.y;
  let endX = sideFace.x;
  let endY = sideFace.y;

  switch (sideFace.side) {
    case "up":
      endX++;
      break;
    case "down":
      endX++;
      startY++;
      endY++;
      break;
    case "left":
      endY++;
      break;
    case "right":
      startX++;
      endX++;
      endY++;
      break;
  }

  startX *= xScale;
  endX *= xScale;
  startY = 16 - startY * yScale;
  endY = 16 - endY * yScale;

  switch (sideFace.side) {
    case "up":
      return { from: [startX, startY, minZ], to: [endX, startY, maxZ], direction: "up" };
    case "down":
      return { from: [startX, endY, minZ], to: [endX, endY, maxZ], direction: "down" };
    case "left":
      return { from: [startX, startY, minZ], to: [startX, endY, maxZ], direction: "east" };
    case "right":
      return { from: [endX, startY, minZ], to: [endX, endY, maxZ], direction: "west" };
  }
}

function getSideUv(sideFace: SideFace, xScale: number, yScale: number): [number, number, number, number] {
  const u0 = sideFace.x + uvShrink;
  const u1 = sideFace.x + 1 - uvShrink;
  const v0 = sideFace.side === "up" || sideFace.side === "down"
    ? sideFace.y + uvShrink
    : sideFace.y + 1 - uvShrink;
  const v1 = sideFace.side === "up" || sideFace.side === "down"
    ? sideFace.y + 1 - uvShrink
    : sideFace.y + uvShrink;

  return [u0 * xScale, v0 * yScale, u1 * xScale, v1 * yScale];
}

function createFace(layer: GeneratedLayer, uv: [number, number, number, number]): RawFace {
  return {
    texture: layer.textureReference,
    uv,
    tintindex: layer.tintindex
  };
}
