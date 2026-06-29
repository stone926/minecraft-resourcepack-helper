import type { PreviewBounds, PreviewDirection, PreviewMesh, PreviewVec3 } from "../ir/PreviewDocument";
import type { RawElement, ResolvedElement, ResolvedModel } from "../model/ModelDocument";
import { ModelIssueCollector } from "../model/ModelIssues";
import { fileUriString } from "../resolve/ResourceDependencyResolver";
import { TextureReferenceResolver } from "../resolve/TextureReferenceResolver";
import { getDefaultUv, getFaceUvs } from "./DefaultUv";
import { createGeneratedItemElements } from "./GeneratedItemModel";

const directions: PreviewDirection[] = ["down", "up", "north", "south", "west", "east"];

export interface BakeResult {
  meshes: PreviewMesh[];
  bounds: PreviewBounds;
}

export class CuboidBaker {
  constructor(
    private readonly textureResolver: TextureReferenceResolver,
    private readonly issues: ModelIssueCollector
  ) { }

  bake(model: ResolvedModel): BakeResult {
    const elements = getRenderableElements(model);
    const meshes: PreviewMesh[] = [];
    const boundsBuilder = new BoundsBuilder();

    elements.forEach((resolvedElement, index) => {
      const mesh = this.bakeElement(resolvedElement, index, boundsBuilder);
      if (mesh.faces.length > 0) {
        meshes.push(mesh);
      }
    });

    if (meshes.length === 0) {
      this.issues.error("Model has no renderable geometry", model.fileName);
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
      this.issues.warning("Element is missing from/to coordinates", resolvedElement.sourceModelFileName);
      return previewMesh;
    }

    for (const direction of directions) {
      const face = faces[direction];
      if (!face) {
        continue;
      }

      if (!face.texture) {
        this.issues.warning(`Face ${direction} is missing texture`, resolvedElement.sourceModelFileName);
        continue;
      }

      const positions = rotatePositions(getFacePositions(direction, from, to), element);
      for (const position of positions) {
        bounds.include(position);
      }

      const material = this.textureResolver.resolve(face.texture, resolvedElement.sourceModelFileName).material;
      previewMesh.faces.push({
        direction,
        positions,
        uvs: getFaceUvs(face.uv ?? getDefaultUv(direction, from, to), face.rotation ?? 0),
        materialId: material.id,
        cullface: face.cullface,
        tintindex: face.tintindex,
        shade: element.shade !== false,
        lightEmission: clampLightEmission(element.light_emission)
      });
    }

    if (element.rotation?.rescale) {
      this.issues.info("Element rotation rescale is approximated in preview", resolvedElement.sourceModelFileName);
    }

    return previewMesh;
  }
}

function getRenderableElements(model: ResolvedModel): ResolvedElement[] {
  if (model.elements.length > 0) {
    return model.elements;
  }

  if (!model.generatedItem) {
    return [];
  }

  return createGeneratedItemElements().map((element, index) => ({
    element,
    index,
    sourceModelFileName: model.fileName
  }));
}

function getFacePositions(direction: PreviewDirection, from: PreviewVec3, to: PreviewVec3): PreviewVec3[] {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;

  switch (direction) {
    case "down":
      return [[x1, y1, z2], [x1, y1, z1], [x2, y1, z1], [x2, y1, z2]];
    case "up":
      return [[x1, y2, z1], [x1, y2, z2], [x2, y2, z2], [x2, y2, z1]];
    case "north":
      return [[x2, y1, z1], [x2, y2, z1], [x1, y2, z1], [x1, y1, z1]];
    case "south":
      return [[x1, y1, z2], [x1, y2, z2], [x2, y2, z2], [x2, y1, z2]];
    case "west":
      return [[x1, y1, z1], [x1, y2, z1], [x1, y2, z2], [x1, y1, z2]];
    case "east":
      return [[x2, y1, z2], [x2, y2, z2], [x2, y2, z1], [x2, y1, z1]];
  }
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
