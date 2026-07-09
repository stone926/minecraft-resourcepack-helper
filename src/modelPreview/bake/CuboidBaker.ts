import type { PreviewBounds, PreviewDirection, PreviewMaterial, PreviewMesh, PreviewRange, PreviewVec3 } from "../ir/PreviewDocument";
import { lm } from "../../i18n/messages";
import type { RawElement, ResolvedElement, ResolvedModel } from "../model/ModelDocument";
import { ModelIssueCollector } from "../model/ModelIssues";
import { fileUriString } from "../paths";
import { throwIfCancellationRequested, type ModelPreviewCancellationToken } from "../cancellation";
import { getDefaultUv, getFaceUvs } from "./DefaultUv";

const directions: PreviewDirection[] = ["down", "up", "north", "south", "west", "east"];
const directionVectors: Record<PreviewDirection, PreviewVec3> = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0]
};

export interface BakeResult {
  meshes: PreviewMesh[];
  bounds: PreviewBounds;
}

export interface MaterialResolver {
  resolveMaterial(textureReference: string, sourceModelFileName: string, referenceRange?: PreviewRange): PreviewMaterial;
}

export class CuboidBaker {
  constructor(
    private readonly materialResolver: MaterialResolver,
    private readonly issues: ModelIssueCollector,
    private readonly cancellationToken?: ModelPreviewCancellationToken
  ) { }

  bake(model: ResolvedModel): BakeResult {
    const elements = getRenderableElements(model);
    const meshes: PreviewMesh[] = [];
    const boundsBuilder = new BoundsBuilder();

    elements.forEach((resolvedElement, index) => {
      throwIfCancellationRequested(this.cancellationToken);
      const mesh = this.bakeElement(resolvedElement, index, boundsBuilder);
      if (mesh.faces.length > 0) {
        meshes.push(mesh);
      }
    });

    if (meshes.length === 0) {
      this.issues.error(lm("Model has no renderable geometry"), model.fileName);
    }

    return {
      meshes,
      bounds: boundsBuilder.toBounds()
    };
  }

  private bakeElement(resolvedElement: ResolvedElement, fallbackIndex: number, bounds: BoundsBuilder): PreviewMesh {
    const element = resolvedElement.element;
    const from = element.from;
    const to = element.to;
    const faces = element.faces ?? {};
    const previewMesh: PreviewMesh = {
      id: `element:${resolvedElement.sourceModelFileName}:${resolvedElement.index}:${fallbackIndex}`,
      elementIndex: resolvedElement.index,
      sourceModelUri: fileUriString(resolvedElement.sourceModelFileName),
      faces: []
    };

    if (!from || !to) {
      this.issues.warning(lm("Element is missing from/to coordinates"), resolvedElement.sourceModelFileName, element.range);
      return previewMesh;
    }

    if (hasOutOfRangeCoordinate(from) || hasOutOfRangeCoordinate(to)) {
      this.issues.warning(
        lm("Element from/to coordinates are outside Minecraft's supported -16..32 range"),
        resolvedElement.sourceModelFileName,
        element.fromRange ?? element.toRange ?? element.range
      );
    }

    const drawableAxes = getDrawableAxes(from, to);
    if (!drawableAxes.x && !drawableAxes.y && !drawableAxes.z) {
      return previewMesh;
    }

    for (const direction of directions) {
      if (!shouldDrawFace(direction, drawableAxes)) {
        continue;
      }

      const face = faces[direction];
      if (!face) {
        continue;
      }

      if (!face.texture) {
        this.issues.warning(lm("Face {0} is missing texture", direction), resolvedElement.sourceModelFileName, face.textureRange ?? face.range);
        continue;
      }

      let positions = rotatePositions(getFacePositions(direction, from, to), element);
      let uvs = getFaceUvs(face.uv ?? getDefaultUv(direction, from, to), face.rotation ?? 0);
      const finalDirection = calculateFacing(positions);
      if (!element.rotation && finalDirection) {
        ({ positions, uvs } = recalculateWinding(positions, uvs, finalDirection));
      }

      for (const position of positions) {
        bounds.include(position);
      }

      const material = this.materialResolver.resolveMaterial(face.texture, resolvedElement.sourceModelFileName, face.textureRange);
      previewMesh.faces.push({
        direction,
        positions,
        uvs,
        materialId: material.id,
        cullface: face.cullface,
        tintindex: face.tintindex,
        shade: element.shade !== false,
        lightEmission: clampLightEmission(element.lightEmission)
      });
    }

    if (element.rotation?.rescale) {
      this.issues.info(lm("Element rotation rescale is approximated in preview"), resolvedElement.sourceModelFileName, element.rotation.rescaleRange);
    }

    return previewMesh;
  }
}

function hasOutOfRangeCoordinate(vector: PreviewVec3): boolean {
  return vector.some(value => value < -16 || value > 32);
}

function getRenderableElements(model: ResolvedModel): ResolvedElement[] {
  return model.elements;
}

function getFacePositions(direction: PreviewDirection, from: PreviewVec3, to: PreviewVec3): PreviewVec3[] {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;

  // Match Minecraft FaceInfo vertex order. The names x1/x2 mirror the JSON
  // fields, not numeric min/max, because negative cuboids depend on that.
  switch (direction) {
    case "down":
      return [[x1, y1, z2], [x1, y1, z1], [x2, y1, z1], [x2, y1, z2]];
    case "up":
      return [[x1, y2, z1], [x1, y2, z2], [x2, y2, z2], [x2, y2, z1]];
    case "north":
      return [[x2, y2, z1], [x2, y1, z1], [x1, y1, z1], [x1, y2, z1]];
    case "south":
      return [[x1, y2, z2], [x1, y1, z2], [x2, y1, z2], [x2, y2, z2]];
    case "west":
      return [[x1, y2, z1], [x1, y1, z1], [x1, y1, z2], [x1, y2, z2]];
    case "east":
      return [[x2, y2, z2], [x2, y1, z2], [x2, y1, z1], [x2, y2, z1]];
  }
}

function getDrawableAxes(from: PreviewVec3, to: PreviewVec3): Record<"x" | "y" | "z", boolean> {
  const axes = { x: true, y: true, z: true };
  if (from[0] === to[0]) {
    axes.y = false;
    axes.z = false;
  }
  if (from[1] === to[1]) {
    axes.x = false;
    axes.z = false;
  }
  if (from[2] === to[2]) {
    axes.x = false;
    axes.y = false;
  }
  return axes;
}

function shouldDrawFace(direction: PreviewDirection, axes: Record<"x" | "y" | "z", boolean>): boolean {
  switch (direction) {
    case "east":
    case "west":
      return axes.x;
    case "up":
    case "down":
      return axes.y;
    case "north":
    case "south":
      return axes.z;
  }
}

function calculateFacing(positions: PreviewVec3[]): PreviewDirection | null {
  const normal = cross(subtract(positions[1], positions[0]), subtract(positions[2], positions[0]));
  if (!normal.every(Number.isFinite) || lengthSquared(normal) === 0) {
    return null;
  }

  let closest: PreviewDirection | null = null;
  let closestProduct = 0;
  for (const direction of directions) {
    const product = dot(normal, directionVectors[direction]);
    if (product >= 0 && product > closestProduct) {
      closestProduct = product;
      closest = direction;
    }
  }
  return closest;
}

function recalculateWinding(
  positions: PreviewVec3[],
  uvs: Array<[number, number]>,
  direction: PreviewDirection
): { positions: PreviewVec3[]; uvs: Array<[number, number]> } {
  const min: PreviewVec3 = [
    Math.min(...positions.map(position => position[0])),
    Math.min(...positions.map(position => position[1])),
    Math.min(...positions.map(position => position[2]))
  ];
  const max: PreviewVec3 = [
    Math.max(...positions.map(position => position[0])),
    Math.max(...positions.map(position => position[1])),
    Math.max(...positions.map(position => position[2]))
  ];
  const targetPositions = getFacePositions(direction, min, max);
  const sourcePositions = positions.map(position => [...position] as PreviewVec3);
  const sourceUvs = uvs.map(uv => [...uv] as [number, number]);
  const targetUvs: Array<[number, number]> = [];

  for (let targetIndex = 0; targetIndex < targetPositions.length; targetIndex++) {
    const sourceIndex = findPosition(sourcePositions, targetIndex, targetPositions[targetIndex]);
    if (sourceIndex === -1) {
      return { positions, uvs };
    }
    if (sourceIndex !== targetIndex) {
      swap(sourcePositions, sourceIndex, targetIndex);
      swap(sourceUvs, sourceIndex, targetIndex);
    }
    targetUvs[targetIndex] = sourceUvs[targetIndex];
  }

  return { positions: targetPositions, uvs: targetUvs };
}

function findPosition(positions: PreviewVec3[], start: number, target: PreviewVec3): number {
  for (let index = start; index < positions.length; index++) {
    if (positions[index][0] === target[0] && positions[index][1] === target[1] && positions[index][2] === target[2]) {
      return index;
    }
  }
  return -1;
}

function swap<T>(items: T[], left: number, right: number): void {
  const item = items[left];
  items[left] = items[right];
  items[right] = item;
}

function subtract(left: PreviewVec3, right: PreviewVec3): PreviewVec3 {
  return [
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2]
  ];
}

function cross(left: PreviewVec3, right: PreviewVec3): PreviewVec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function dot(left: PreviewVec3, right: PreviewVec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function lengthSquared(vector: PreviewVec3): number {
  return dot(vector, vector);
}

function rotatePositions(positions: PreviewVec3[], element: RawElement): PreviewVec3[] {
  const rotation = element.rotation;
  if (!rotation) {
    return positions;
  }

  const origin = rotation.origin ?? [8, 8, 8];
  const angles = {
    x: rotation.x ?? (rotation.axis === "x" ? rotation.angle ?? 0 : 0),
    y: rotation.y ?? (rotation.axis === "y" ? rotation.angle ?? 0 : 0),
    z: rotation.z ?? (rotation.axis === "z" ? rotation.angle ?? 0 : 0)
  };

  return positions.map(position => rotateVec3(position, origin, angles.x, angles.y, angles.z));
}

function rotateVec3(position: PreviewVec3, origin: PreviewVec3, xDegrees: number, yDegrees: number, zDegrees: number): PreviewVec3 {
  let [x, y, z] = [
    position[0] - origin[0],
    position[1] - origin[1],
    position[2] - origin[2]
  ];

  [y, z] = rotate2d(y, z, xDegrees);
  [x, z] = rotate2d(x, z, -yDegrees);
  [x, y] = rotate2d(x, y, zDegrees);

  return [
    x + origin[0],
    y + origin[1],
    z + origin[2]
  ];
}

function rotate2d(a: number, b: number, degrees: number): [number, number] {
  if (degrees === 0) {
    return [a, b];
  }

  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    a * cos - b * sin,
    a * sin + b * cos
  ];
}

function clampLightEmission(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }

  return Math.min(15, Math.max(0, Math.trunc(value)));
}

class BoundsBuilder {
  private min: PreviewVec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  private max: PreviewVec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];

  include(position: PreviewVec3): void {
    for (let index = 0; index < 3; index++) {
      this.min[index] = Math.min(this.min[index], position[index]);
      this.max[index] = Math.max(this.max[index], position[index]);
    }
  }

  toBounds(): PreviewBounds {
    if (!Number.isFinite(this.min[0])) {
      return {
        min: [0, 0, 0],
        max: [0, 0, 0]
      };
    }

    return {
      min: [...this.min],
      max: [...this.max]
    };
  }
}
