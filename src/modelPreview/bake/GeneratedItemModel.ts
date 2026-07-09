import type { PreviewDirection, PreviewRange, PreviewVec3 } from "../ir/PreviewDocument";
import { lm } from "../../i18n/messages";
import type { RawElement, RawFace, ResolvedElement, ResolvedModel } from "../model/ModelDocument";
import { ModelIssueCollector } from "../model/ModelIssues";
import { throwIfCancellationRequested, type ModelPreviewCancellationToken } from "../cancellation";
import type { PngAlphaMask } from "./AlphaMask";

const itemLayers = ["layer0", "layer1", "layer2", "layer3", "layer4"];
const minZ = 7.5;
const maxZ = 8.5;
const uvShrink = 0.1;
const fallbackSpriteSize = 16;
const maxDetailedAlphaMaskPixels = 256 * 256;
const maxGeneratedSideSpans = 4096;

interface GeneratedLayer {
  textureReference: string;
  tintindex: number;
  issueFileName: string;
  alphaMask: PngAlphaMask | null;
}

interface SideSpan {
  side: SideDirection;
  x: number;
  y: number;
  length: number;
}

type SideDirection = "up" | "down" | "left" | "right";

type TextureAlphaReader = (
  fileName: string,
  issues: ModelIssueCollector,
  token?: ModelPreviewCancellationToken
) => Promise<PngAlphaMask | null>;

export interface GeneratedItemTextureResolver {
  resolve(textureReference: string, sourceModelFileName: string, referenceRange?: PreviewRange): {
    textureFileName?: string;
  };
}

export async function createGeneratedItemElements(
  model: ResolvedModel,
  textureResolver: GeneratedItemTextureResolver,
  issues: ModelIssueCollector,
  readTextureAlpha: TextureAlphaReader,
  cancellationToken?: ModelPreviewCancellationToken
): Promise<ResolvedElement[]> {
  const layers = await resolveGeneratedLayers(model, textureResolver, issues, readTextureAlpha, cancellationToken);
  const elements: ResolvedElement[] = [];

  for (const layer of layers) {
    throwIfCancellationRequested(cancellationToken);
    for (const element of createLayerElements(layer, issues, cancellationToken)) {
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
  textureResolver: GeneratedItemTextureResolver,
  issues: ModelIssueCollector,
  readTextureAlpha: TextureAlphaReader,
  cancellationToken?: ModelPreviewCancellationToken
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
      issueFileName: resolution.textureFileName ?? model.fileName,
      alphaMask
    });
  }

  return layers;
}

function createLayerElements(
  layer: GeneratedLayer,
  issues: ModelIssueCollector,
  cancellationToken?: ModelPreviewCancellationToken
): RawElement[] {
  return [
    createFrontBackElement(layer),
    ...createSideElements(layer, issues, cancellationToken)
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

function createSideElements(
  layer: GeneratedLayer,
  issues: ModelIssueCollector,
  cancellationToken?: ModelPreviewCancellationToken
): RawElement[] {
  const alphaMask = layer.alphaMask ?? createFallbackAlphaMask();
  const xScale = 16 / alphaMask.width;
  const yScale = 16 / alphaMask.height;
  let sideSpans = getSideSpans(alphaMask, cancellationToken);
  if (!sideSpans) {
    issues.info(lm("Generated item side extrusion is simplified because texture alpha detail is too large"), layer.issueFileName);
    const fallbackAlphaMask = createFallbackAlphaMask();
    sideSpans = getSideSpans(fallbackAlphaMask, cancellationToken) ?? [];
    return sideSpans.map(sideSpan => createSideElement(layer, sideSpan, 16 / fallbackAlphaMask.width, 16 / fallbackAlphaMask.height));
  }

  return sideSpans.map(sideSpan => createSideElement(layer, sideSpan, xScale, yScale));
}

function createFallbackAlphaMask(): PngAlphaMask {
  return {
    width: fallbackSpriteSize,
    height: fallbackSpriteSize,
    isOpaque: () => true
  };
}

function getSideSpans(alphaMask: PngAlphaMask, cancellationToken?: ModelPreviewCancellationToken): SideSpan[] | null {
  if (alphaMask.width * alphaMask.height > maxDetailedAlphaMaskPixels) {
    return null;
  }

  const sideSpans: SideSpan[] = [];

  for (let y = 0; y < alphaMask.height; y++) {
    throwIfCancellationRequested(cancellationToken);
    collectHorizontalSideSpans(sideSpans, alphaMask, "up", y, -1);
    collectHorizontalSideSpans(sideSpans, alphaMask, "down", y, 1);
    if (sideSpans.length > maxGeneratedSideSpans) {
      return null;
    }
  }

  for (let x = 0; x < alphaMask.width; x++) {
    throwIfCancellationRequested(cancellationToken);
    collectVerticalSideSpans(sideSpans, alphaMask, "left", x, -1);
    collectVerticalSideSpans(sideSpans, alphaMask, "right", x, 1);
    if (sideSpans.length > maxGeneratedSideSpans) {
      return null;
    }
  }

  return sideSpans;
}

function collectHorizontalSideSpans(
  sideSpans: SideSpan[],
  alphaMask: PngAlphaMask,
  side: Extract<SideDirection, "up" | "down">,
  y: number,
  neighborOffsetY: number
): void {
  let startX: number | null = null;
  for (let x = 0; x < alphaMask.width; x++) {
    const visible = alphaMask.isOpaque(x, y) && isTransparent(alphaMask, x, y + neighborOffsetY);
    startX = collectSideSpan(sideSpans, visible, side, startX, x, y);
  }
  closeSideSpan(sideSpans, side, startX, alphaMask.width, y);
}

function collectVerticalSideSpans(
  sideSpans: SideSpan[],
  alphaMask: PngAlphaMask,
  side: Extract<SideDirection, "left" | "right">,
  x: number,
  neighborOffsetX: number
): void {
  let startY: number | null = null;
  for (let y = 0; y < alphaMask.height; y++) {
    const visible = alphaMask.isOpaque(x, y) && isTransparent(alphaMask, x + neighborOffsetX, y);
    startY = collectSideSpan(sideSpans, visible, side, startY, x, y);
  }
  closeSideSpan(sideSpans, side, startY, x, alphaMask.height);
}

function collectSideSpan(
  sideSpans: SideSpan[],
  visible: boolean,
  side: SideDirection,
  spanStart: number | null,
  x: number,
  y: number
): number | null {
  if (visible) {
    return spanStart ?? (side === "up" || side === "down" ? x : y);
  }

  closeSideSpan(sideSpans, side, spanStart, x, y);
  return null;
}

function closeSideSpan(
  sideSpans: SideSpan[],
  side: SideDirection,
  spanStart: number | null,
  x: number,
  y: number
): void {
  if (spanStart === null) {
    return;
  }

  if (side === "up" || side === "down") {
    sideSpans.push({ side, x: spanStart, y, length: x - spanStart });
    return;
  }

  sideSpans.push({ side, x, y: spanStart, length: y - spanStart });
}

function isTransparent(alphaMask: PngAlphaMask, x: number, y: number): boolean {
  return x < 0 || y < 0 || x >= alphaMask.width || y >= alphaMask.height || !alphaMask.isOpaque(x, y);
}

function createSideElement(layer: GeneratedLayer, sideSpan: SideSpan, xScale: number, yScale: number): RawElement {
  const { from, to, direction } = getSideGeometry(sideSpan, xScale, yScale);
  return {
    from,
    to,
    faces: {
      [direction]: createFace(layer, getSideUv(sideSpan, xScale, yScale))
    }
  };
}

function getSideGeometry(
  sideSpan: SideSpan,
  xScale: number,
  yScale: number
): { from: PreviewVec3; to: PreviewVec3; direction: PreviewDirection } {
  let startX = sideSpan.x;
  let startY = sideSpan.y;
  let endX = sideSpan.x;
  let endY = sideSpan.y;

  switch (sideSpan.side) {
    case "up":
      endX += sideSpan.length;
      break;
    case "down":
      endX += sideSpan.length;
      startY++;
      endY++;
      break;
    case "left":
      endY += sideSpan.length;
      break;
    case "right":
      startX++;
      endX++;
      endY += sideSpan.length;
      break;
  }

  startX *= xScale;
  endX *= xScale;
  startY = 16 - startY * yScale;
  endY = 16 - endY * yScale;

  switch (sideSpan.side) {
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

function getSideUv(sideSpan: SideSpan, xScale: number, yScale: number): [number, number, number, number] {
  const isHorizontal = sideSpan.side === "up" || sideSpan.side === "down";
  const u0 = sideSpan.x + uvShrink;
  const u1 = sideSpan.x + (isHorizontal ? sideSpan.length : 1) - uvShrink;
  const v0 = isHorizontal
    ? sideSpan.y + uvShrink
    : sideSpan.y + sideSpan.length - uvShrink;
  const v1 = isHorizontal
    ? sideSpan.y + 1 - uvShrink
    : sideSpan.y + uvShrink;

  return [u0 * xScale, v0 * yScale, u1 * xScale, v1 * yScale];
}

function createFace(layer: GeneratedLayer, uv: [number, number, number, number]): RawFace {
  return {
    texture: layer.textureReference,
    uv,
    tintindex: layer.tintindex
  };
}
