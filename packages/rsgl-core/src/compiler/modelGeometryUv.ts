import {
  getCanonicalFaceVertices,
  getCanonicalFaceBasis,
  getDefaultUv,
  getFaceUvs,
  signedAxisVector,
  transformPoint,
  transformVector,
  type ModelFaceDirection,
  type ModelVec2,
  type ModelVec3,
  type SignedPermutationTransform,
  type UvRect
} from "../../../mc-assets/src";

export type ModelFaceRotation = 0 | 90 | 180 | 270;

export interface ModelFaceUvTransformInput {
  sourceDirection: ModelFaceDirection;
  targetDirection: ModelFaceDirection;
  sourceFrom: ModelVec3;
  sourceTo: ModelVec3;
  targetFrom: ModelVec3;
  targetTo: ModelVec3;
  transform: SignedPermutationTransform;
  explicitUv?: UvRect;
  rotation?: number;
}

export interface ModelFaceUvTransformSuccess {
  ok: true;
  uv?: UvRect;
  rotation: ModelFaceRotation;
}

export interface ModelFaceUvTransformFailure {
  ok: false;
  reason: "invalidRotation" | "unmatchedVertex" | "unsupportedBasis" | "unrepresentableCorners";
}

export type ModelFaceUvTransformResult = ModelFaceUvTransformSuccess | ModelFaceUvTransformFailure;

/**
 * Carries a face's four texture corners through an exact geometry transform,
 * then re-encodes them as a Minecraft UV rectangle plus quarter rotation.
 */
export function transformModelFaceUv(input: ModelFaceUvTransformInput): ModelFaceUvTransformResult {
  const rotation = modelFaceRotation(input.rotation ?? 0);
  if (rotation === undefined) {
    return { ok: false, reason: "invalidRotation" };
  }

  const sourceUv = input.explicitUv ?? getDefaultUv(
    input.sourceDirection,
    input.sourceFrom,
    input.sourceTo
  );
  const sourceCorners = getFaceUvs(sourceUv, rotation);
  const transformedCorners = transformUvCoordinates(
    sourceCorners,
    input.sourceDirection,
    input.targetDirection,
    input.transform
  );
  if (!transformedCorners) {
    return { ok: false, reason: "unsupportedBasis" };
  }
  const transformedVertices = getCanonicalFaceVertices(
    input.sourceDirection,
    input.sourceFrom,
    input.sourceTo
  ).map(vertex => transformPoint(input.transform, vertex));
  const targetVertices = getCanonicalFaceVertices(
    input.targetDirection,
    input.targetFrom,
    input.targetTo
  );
  const targetCorners = reorderUvCorners(transformedVertices, transformedCorners, targetVertices);
  if (!targetCorners) {
    return { ok: false, reason: "unmatchedVertex" };
  }

  const preferredRotations = rotationCandidates(rotation);
  if (!input.explicitUv) {
    const targetDefaultUv = getDefaultUv(input.targetDirection, input.targetFrom, input.targetTo);
    for (const candidate of preferredRotations) {
      if (uvCornersEqual(getFaceUvs(targetDefaultUv, candidate), targetCorners)) {
        return { ok: true, rotation: candidate };
      }
    }
  }

  for (const candidate of preferredRotations) {
    const encoded = encodeUvCorners(targetCorners, candidate);
    if (encoded) {
      return { ok: true, uv: encoded, rotation: candidate };
    }
  }
  return { ok: false, reason: "unrepresentableCorners" };
}

function transformUvCoordinates(
  corners: readonly ModelVec2[],
  sourceDirection: ModelFaceDirection,
  targetDirection: ModelFaceDirection,
  transform: SignedPermutationTransform
): ModelVec2[] | undefined {
  const sourceBasis = getCanonicalFaceBasis(sourceDirection);
  const targetBasis = getCanonicalFaceBasis(targetDirection);
  const targetAxes = [signedAxisVector(targetBasis.uAxis), signedAxisVector(targetBasis.vAxis)] as const;
  const mappings = [sourceBasis.uAxis, sourceBasis.vAxis].map(sourceAxis =>
    projectedTextureAxis(transformVector(transform.matrix, signedAxisVector(sourceAxis)), targetAxes)
  );
  if (!mappings[0] || !mappings[1] || mappings[0].targetIndex === mappings[1].targetIndex) {
    return undefined;
  }
  return corners.map(corner => {
    const transformed: ModelVec2 = [0, 0];
    for (let sourceIndex = 0; sourceIndex < 2; sourceIndex++) {
      const mapping = mappings[sourceIndex]!;
      const value = corner[sourceIndex];
      transformed[mapping.targetIndex] = mapping.sign === 1 ? value : 16 - value;
    }
    return transformed;
  });
}

function projectedTextureAxis(
  sourceAxis: ModelVec3,
  targetAxes: readonly [ModelVec3, ModelVec3]
): { targetIndex: 0 | 1; sign: -1 | 1 } | undefined {
  for (const targetIndex of [0, 1] as const) {
    const targetAxis = targetAxes[targetIndex];
    if (vectorsEqual(sourceAxis, targetAxis)) {
      return { targetIndex, sign: 1 };
    }
    if (
      sourceAxis[0] === -targetAxis[0]
      && sourceAxis[1] === -targetAxis[1]
      && sourceAxis[2] === -targetAxis[2]
    ) {
      return { targetIndex, sign: -1 };
    }
  }
  return undefined;
}

function reorderUvCorners(
  sourceVertices: readonly ModelVec3[],
  sourceCorners: readonly ModelVec2[],
  targetVertices: readonly ModelVec3[]
): ModelVec2[] | undefined {
  const usedSourceIndexes = new Set<number>();
  const targetCorners: ModelVec2[] = [];
  for (const targetVertex of targetVertices) {
    const sourceIndex = sourceVertices.findIndex((sourceVertex, index) =>
      !usedSourceIndexes.has(index) && vectorsEqual(sourceVertex, targetVertex)
    );
    if (sourceIndex === -1) {
      return undefined;
    }
    usedSourceIndexes.add(sourceIndex);
    targetCorners.push([...sourceCorners[sourceIndex]]);
  }
  return targetCorners;
}

function encodeUvCorners(corners: readonly ModelVec2[], rotation: ModelFaceRotation): UvRect | undefined {
  const turns = rotation / 90;
  const baseCorners = corners.map((_, baseIndex) =>
    corners[(baseIndex - turns + corners.length) % corners.length]
  );
  if (
    baseCorners[0][0] !== baseCorners[1][0]
    || baseCorners[1][1] !== baseCorners[2][1]
    || baseCorners[2][0] !== baseCorners[3][0]
    || baseCorners[3][1] !== baseCorners[0][1]
  ) {
    return undefined;
  }
  return [baseCorners[0][0], baseCorners[0][1], baseCorners[2][0], baseCorners[2][1]];
}

function rotationCandidates(preferred: ModelFaceRotation): ModelFaceRotation[] {
  const rotations: ModelFaceRotation[] = [preferred];
  for (const candidate of [0, 90, 180, 270] as const) {
    if (candidate !== preferred) {
      rotations.push(candidate);
    }
  }
  return rotations;
}

function modelFaceRotation(value: number): ModelFaceRotation | undefined {
  return value === 0 || value === 90 || value === 180 || value === 270
    ? value
    : undefined;
}

function vectorsEqual(left: ModelVec3, right: ModelVec3): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function uvCornersEqual(left: readonly ModelVec2[], right: readonly ModelVec2[]): boolean {
  return left.length === right.length
    && left.every((corner, index) => corner[0] === right[index][0] && corner[1] === right[index][1]);
}
