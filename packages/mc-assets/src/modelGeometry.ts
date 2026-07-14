export type ModelAxis = "x" | "y" | "z";

export type ModelFaceDirection = "down" | "up" | "north" | "south" | "west" | "east";

export type ModelVec2 = [number, number];

export type ModelVec3 = [number, number, number];

export type ReadonlyModelVec3 = readonly [number, number, number];

export type UvRect = [number, number, number, number];

export type FaceVertices = [ModelVec3, ModelVec3, ModelVec3, ModelVec3];

export type AxisSign = -1 | 1;

export interface SignedModelAxis {
  readonly axis: ModelAxis;
  readonly sign: AxisSign;
}

export interface CanonicalFaceBasis {
  readonly uAxis: SignedModelAxis;
  readonly vAxis: SignedModelAxis;
  readonly normal: SignedModelAxis;
}

export type SignedPermutationEntry = -1 | 0 | 1;

export type SignedPermutationMatrix = readonly [
  readonly [SignedPermutationEntry, SignedPermutationEntry, SignedPermutationEntry],
  readonly [SignedPermutationEntry, SignedPermutationEntry, SignedPermutationEntry],
  readonly [SignedPermutationEntry, SignedPermutationEntry, SignedPermutationEntry]
];

/**
 * An exact affine transform whose linear part permutes and optionally negates
 * the model axes. Points are transformed as `matrix * point + translation`.
 */
export interface SignedPermutationTransform {
  readonly matrix: SignedPermutationMatrix;
  readonly translation: ReadonlyModelVec3;
}

export interface DirectedModelBounds {
  readonly from: ModelVec3;
  readonly to: ModelVec3;
}

export const MODEL_AXES: readonly ModelAxis[] = ["x", "y", "z"];

export const MODEL_FACE_DIRECTIONS: readonly ModelFaceDirection[] = [
  "down",
  "up",
  "north",
  "south",
  "west",
  "east"
];

export const DEFAULT_MODEL_TRANSFORM_ORIGIN: ReadonlyModelVec3 = [8, 8, 8];

export const IDENTITY_SIGNED_PERMUTATION_MATRIX: SignedPermutationMatrix = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
];

export const IDENTITY_SIGNED_PERMUTATION_TRANSFORM: SignedPermutationTransform = {
  matrix: IDENTITY_SIGNED_PERMUTATION_MATRIX,
  translation: [0, 0, 0]
};

export const CANONICAL_FACE_BASES: Readonly<Record<ModelFaceDirection, CanonicalFaceBasis>> = {
  down: {
    uAxis: { axis: "x", sign: 1 },
    vAxis: { axis: "z", sign: -1 },
    normal: { axis: "y", sign: -1 }
  },
  up: {
    uAxis: { axis: "x", sign: 1 },
    vAxis: { axis: "z", sign: 1 },
    normal: { axis: "y", sign: 1 }
  },
  north: {
    uAxis: { axis: "x", sign: -1 },
    vAxis: { axis: "y", sign: -1 },
    normal: { axis: "z", sign: -1 }
  },
  south: {
    uAxis: { axis: "x", sign: 1 },
    vAxis: { axis: "y", sign: -1 },
    normal: { axis: "z", sign: 1 }
  },
  west: {
    uAxis: { axis: "z", sign: 1 },
    vAxis: { axis: "y", sign: -1 },
    normal: { axis: "x", sign: -1 }
  },
  east: {
    uAxis: { axis: "z", sign: -1 },
    vAxis: { axis: "y", sign: -1 },
    normal: { axis: "x", sign: 1 }
  }
};

const positiveQuarterTurnMatrices: Readonly<Record<ModelAxis, SignedPermutationMatrix>> = {
  x: [
    [1, 0, 0],
    [0, 0, -1],
    [0, 1, 0]
  ],
  y: [
    [0, 0, -1],
    [0, 1, 0],
    [1, 0, 0]
  ],
  z: [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1]
  ]
};

export function getCanonicalFaceBasis(direction: ModelFaceDirection): CanonicalFaceBasis {
  return CANONICAL_FACE_BASES[direction];
}

export function signedAxisVector(axis: SignedModelAxis): ModelVec3 {
  switch (axis.axis) {
    case "x":
      return [axis.sign, 0, 0];
    case "y":
      return [0, axis.sign, 0];
    case "z":
      return [0, 0, axis.sign];
  }
}

/**
 * Returns Minecraft's canonical face vertex order. `from` and `to` are kept
 * directed: their names refer to the JSON fields, not numeric minima/maxima.
 */
export function getCanonicalFaceVertices(
  direction: ModelFaceDirection,
  from: ReadonlyModelVec3,
  to: ReadonlyModelVec3
): FaceVertices {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;

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

export function getDefaultUv(
  direction: ModelFaceDirection,
  from: ReadonlyModelVec3,
  to: ReadonlyModelVec3
): UvRect {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;

  switch (direction) {
    case "down":
      return [x1, 16 - z2, x2, 16 - z1];
    case "up":
      return [x1, z1, x2, z2];
    case "north":
      return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
    case "south":
      return [x1, 16 - y2, x2, 16 - y1];
    case "west":
      return [z1, 16 - y2, z2, 16 - y1];
    case "east":
      return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
  }
}

/**
 * Decodes a Minecraft UV rectangle and quarter-turn face rotation into the UV
 * coordinates corresponding to the canonical face vertex order.
 */
export function getFaceUvs(rect: UvRect, rotation = 0): ModelVec2[] {
  const [u1, v1, u2, v2] = rect;
  const baseUvs: ModelVec2[] = [
    [u1, v1],
    [u1, v2],
    [u2, v2],
    [u2, v1]
  ];
  const turns = ((((rotation % 360) + 360) % 360) / 90) | 0;
  return baseUvs.map((_, index) => baseUvs[(index + turns) % baseUvs.length]);
}

export function isSignedPermutationMatrix(value: unknown): value is SignedPermutationMatrix {
  if (!Array.isArray(value) || value.length !== 3) {
    return false;
  }

  const columnCounts = [0, 0, 0];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 3) {
      return false;
    }

    let rowCount = 0;
    for (let column = 0; column < 3; column++) {
      const entry = row[column];
      if (entry !== -1 && entry !== 0 && entry !== 1) {
        return false;
      }
      if (entry !== 0) {
        rowCount++;
        columnCounts[column]++;
      }
    }
    if (rowCount !== 1) {
      return false;
    }
  }

  return columnCounts.every(count => count === 1);
}

export function multiplySignedPermutationMatrices(
  left: SignedPermutationMatrix,
  right: SignedPermutationMatrix
): SignedPermutationMatrix {
  return [
    [multiplyMatrixEntry(left, right, 0, 0), multiplyMatrixEntry(left, right, 0, 1), multiplyMatrixEntry(left, right, 0, 2)],
    [multiplyMatrixEntry(left, right, 1, 0), multiplyMatrixEntry(left, right, 1, 1), multiplyMatrixEntry(left, right, 1, 2)],
    [multiplyMatrixEntry(left, right, 2, 0), multiplyMatrixEntry(left, right, 2, 1), multiplyMatrixEntry(left, right, 2, 2)]
  ];
}

export function transformVector(
  matrix: SignedPermutationMatrix,
  vector: ReadonlyModelVec3
): ModelVec3 {
  return [
    normalizeZero(matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2]),
    normalizeZero(matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2]),
    normalizeZero(matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2])
  ];
}

export function transformPoint(
  transform: SignedPermutationTransform,
  point: ReadonlyModelVec3
): ModelVec3 {
  const transformed = transformVector(transform.matrix, point);
  return [
    normalizeZero(transformed[0] + transform.translation[0]),
    normalizeZero(transformed[1] + transform.translation[1]),
    normalizeZero(transformed[2] + transform.translation[2])
  ];
}

export function transformDirection(
  transform: SignedPermutationTransform,
  direction: ModelFaceDirection
): ModelFaceDirection {
  const vector = transformVector(transform.matrix, signedAxisVector(CANONICAL_FACE_BASES[direction].normal));
  const transformedDirection = directionFromNormal(vector);
  if (!transformedDirection) {
    throw new RangeError("The transform did not map the face normal to a model axis.");
  }
  return transformedDirection;
}

export function signedPermutationDeterminant(matrix: SignedPermutationMatrix): AxisSign {
  const determinant = matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
    - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
    + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
  if (determinant !== -1 && determinant !== 1) {
    throw new RangeError("Expected a signed-permutation matrix with determinant -1 or 1.");
  }
  return determinant;
}

/**
 * Composes affine transforms in inside-out order. The returned transform
 * applies `inner` first and `outer` second.
 */
export function composeSignedPermutationTransforms(
  outer: SignedPermutationTransform,
  inner: SignedPermutationTransform
): SignedPermutationTransform {
  const innerTranslationInOuterSpace = transformVector(outer.matrix, inner.translation);
  return {
    matrix: multiplySignedPermutationMatrices(outer.matrix, inner.matrix),
    translation: [
      normalizeZero(innerTranslationInOuterSpace[0] + outer.translation[0]),
      normalizeZero(innerTranslationInOuterSpace[1] + outer.translation[1]),
      normalizeZero(innerTranslationInOuterSpace[2] + outer.translation[2])
    ]
  };
}

export function createQuarterTurnTransform(
  axis: ModelAxis,
  quarterTurns: number,
  around: ReadonlyModelVec3 = DEFAULT_MODEL_TRANSFORM_ORIGIN
): SignedPermutationTransform {
  if (!Number.isInteger(quarterTurns)) {
    throw new RangeError("Quarter turns must be a finite integer.");
  }

  const normalizedTurns = ((quarterTurns % 4) + 4) % 4;
  let matrix = IDENTITY_SIGNED_PERMUTATION_MATRIX;
  for (let index = 0; index < normalizedTurns; index++) {
    matrix = multiplySignedPermutationMatrices(positiveQuarterTurnMatrices[axis], matrix);
  }
  return createPivotedTransform(matrix, around);
}

export function createMirrorTransform(
  axes: ModelAxis | readonly ModelAxis[],
  around: ReadonlyModelVec3 = DEFAULT_MODEL_TRANSFORM_ORIGIN
): SignedPermutationTransform {
  const mirroredAxes = new Set(typeof axes === "string" ? [axes] : axes);
  const matrix: SignedPermutationMatrix = [
    [mirroredAxes.has("x") ? -1 : 1, 0, 0],
    [0, mirroredAxes.has("y") ? -1 : 1, 0],
    [0, 0, mirroredAxes.has("z") ? -1 : 1]
  ];
  return createPivotedTransform(matrix, around);
}

export function createTranslationTransform(offset: ReadonlyModelVec3): SignedPermutationTransform {
  return {
    matrix: IDENTITY_SIGNED_PERMUTATION_MATRIX,
    translation: [...offset]
  };
}

/**
 * Applies a signed-permutation transform without losing JSON `from`/`to`
 * direction. A negated input axis swaps the two corresponding endpoints.
 */
export function transformDirectedBounds(
  transform: SignedPermutationTransform,
  from: ReadonlyModelVec3,
  to: ReadonlyModelVec3
): DirectedModelBounds {
  const transformedFrom = transformPoint(transform, from);
  const transformedTo = transformPoint(transform, to);
  const directedFrom: ModelVec3 = [0, 0, 0];
  const directedTo: ModelVec3 = [0, 0, 0];

  for (let outputAxis = 0; outputAxis < 3; outputAxis++) {
    const reversesDirection = transform.matrix[outputAxis].some(entry => entry === -1);
    directedFrom[outputAxis] = reversesDirection ? transformedTo[outputAxis] : transformedFrom[outputAxis];
    directedTo[outputAxis] = reversesDirection ? transformedFrom[outputAxis] : transformedTo[outputAxis];
  }

  return { from: directedFrom, to: directedTo };
}

function createPivotedTransform(
  matrix: SignedPermutationMatrix,
  around: ReadonlyModelVec3
): SignedPermutationTransform {
  const transformedOrigin = transformVector(matrix, around);
  return {
    matrix,
    translation: [
      normalizeZero(around[0] - transformedOrigin[0]),
      normalizeZero(around[1] - transformedOrigin[1]),
      normalizeZero(around[2] - transformedOrigin[2])
    ]
  };
}

function directionFromNormal(normal: ReadonlyModelVec3): ModelFaceDirection | undefined {
  const [x, y, z] = normal;
  if (x === -1 && y === 0 && z === 0) {
    return "west";
  }
  if (x === 1 && y === 0 && z === 0) {
    return "east";
  }
  if (x === 0 && y === -1 && z === 0) {
    return "down";
  }
  if (x === 0 && y === 1 && z === 0) {
    return "up";
  }
  if (x === 0 && y === 0 && z === -1) {
    return "north";
  }
  if (x === 0 && y === 0 && z === 1) {
    return "south";
  }
  return undefined;
}

function normalizeSignedPermutationEntry(value: number): SignedPermutationEntry {
  if (value !== -1 && value !== 0 && value !== 1) {
    throw new RangeError("Matrix multiplication did not produce a signed-permutation entry.");
  }
  return value;
}

function multiplyMatrixEntry(
  left: SignedPermutationMatrix,
  right: SignedPermutationMatrix,
  row: 0 | 1 | 2,
  column: 0 | 1 | 2
): SignedPermutationEntry {
  return normalizeSignedPermutationEntry(
    left[row][0] * right[0][column]
      + left[row][1] * right[1][column]
      + left[row][2] * right[2][column]
  );
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}
