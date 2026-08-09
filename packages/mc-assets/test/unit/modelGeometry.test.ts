import * as assert from "node:assert/strict";
import {
  CANONICAL_FACE_BASES,
  IDENTITY_SIGNED_PERMUTATION_MATRIX,
  composeSignedPermutationTransforms,
  createMirrorTransform,
  createQuarterTurnTransform,
  createTranslationTransform,
  getCanonicalFaceBasis,
  getCanonicalFaceVertices,
  getDefaultUv,
  getFaceUvs,
  isSignedPermutationMatrix,
  multiplySignedPermutationMatrices,
  signedAxisVector,
  signedPermutationDeterminant,
  transformDirectedBounds,
  transformDirection,
  transformPoint,
  transformVector,
  type ModelFaceDirection,
  type ModelVec3,
  type SignedPermutationTransform
} from "../../src";

describe("shared model geometry", () => {
  it("defines the canonical texture basis for every model face", () => {
    assert.deepStrictEqual(CANONICAL_FACE_BASES, {
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
    });

    assert.deepStrictEqual(getCanonicalFaceBasis("north"), CANONICAL_FACE_BASES.north);
    assert.deepStrictEqual(signedAxisVector(CANONICAL_FACE_BASES.west.normal), [-1, 0, 0]);
  });

  it("returns Minecraft's directed canonical vertex order for all faces", () => {
    const from: ModelVec3 = [1, 2, 3];
    const to: ModelVec3 = [4, 5, 6];
    assert.deepStrictEqual(getCanonicalFaceVertices("down", from, to), [
      [1, 2, 6], [1, 2, 3], [4, 2, 3], [4, 2, 6]
    ]);
    assert.deepStrictEqual(getCanonicalFaceVertices("up", from, to), [
      [1, 5, 3], [1, 5, 6], [4, 5, 6], [4, 5, 3]
    ]);
    assert.deepStrictEqual(getCanonicalFaceVertices("north", from, to), [
      [4, 5, 3], [4, 2, 3], [1, 2, 3], [1, 5, 3]
    ]);
    assert.deepStrictEqual(getCanonicalFaceVertices("south", from, to), [
      [1, 5, 6], [1, 2, 6], [4, 2, 6], [4, 5, 6]
    ]);
    assert.deepStrictEqual(getCanonicalFaceVertices("west", from, to), [
      [1, 5, 3], [1, 2, 3], [1, 2, 6], [1, 5, 6]
    ]);
    assert.deepStrictEqual(getCanonicalFaceVertices("east", from, to), [
      [4, 5, 6], [4, 2, 6], [4, 2, 3], [4, 5, 3]
    ]);

    assert.deepStrictEqual(getCanonicalFaceVertices("north", to, from), [
      [1, 2, 6], [1, 5, 6], [4, 5, 6], [4, 2, 6]
    ]);
  });

  it("shares the six Minecraft default-UV formulas", () => {
    const from: ModelVec3 = [1, 2, 3];
    const to: ModelVec3 = [4, 5, 6];
    const expected = new Map<ModelFaceDirection, [number, number, number, number]>([
      ["down", [1, 10, 4, 13]],
      ["up", [1, 3, 4, 6]],
      ["north", [12, 11, 15, 14]],
      ["south", [1, 11, 4, 14]],
      ["west", [3, 11, 6, 14]],
      ["east", [10, 11, 13, 14]]
    ]);

    for (const [direction, uv] of expected) {
      assert.deepStrictEqual(getDefaultUv(direction, from, to), uv);
    }

    assert.deepStrictEqual(getDefaultUv("south", to, from), [4, 14, 1, 11]);
  });

  it("decodes positive, wrapped, and negative face rotations compatibly", () => {
    const rect: [number, number, number, number] = [2, 3, 14, 11];
    assert.deepStrictEqual(getFaceUvs(rect), [[2, 3], [2, 11], [14, 11], [14, 3]]);
    assert.deepStrictEqual(getFaceUvs(rect, 90), [[2, 11], [14, 11], [14, 3], [2, 3]]);
    assert.deepStrictEqual(getFaceUvs(rect, 180), [[14, 11], [14, 3], [2, 3], [2, 11]]);
    assert.deepStrictEqual(getFaceUvs(rect, 270), [[14, 3], [2, 3], [2, 11], [14, 11]]);
    assert.deepStrictEqual(getFaceUvs(rect, -90), getFaceUvs(rect, 270));
    assert.deepStrictEqual(getFaceUvs(rect, 450), getFaceUvs(rect, 90));
  });

  it("recognizes and multiplies signed-permutation matrices", () => {
    assert.strictEqual(isSignedPermutationMatrix(IDENTITY_SIGNED_PERMUTATION_MATRIX), true);
    assert.strictEqual(isSignedPermutationMatrix([[1, 0, 0], [1, 0, 0], [0, 0, 1]]), false);
    assert.strictEqual(isSignedPermutationMatrix([[1, 0, 0], [0, 0.5, 0], [0, 0, 1]]), false);

    const quarterY = createQuarterTurnTransform("y", 1, [0, 0, 0]);
    assert.deepStrictEqual(
      multiplySignedPermutationMatrices(quarterY.matrix, quarterY.matrix),
      createQuarterTurnTransform("y", 2, [0, 0, 0]).matrix
    );
    assert.deepStrictEqual(transformVector(quarterY.matrix, [1, 2, 3]), [-3, 2, 1]);
  });

  it("implements the specified positive quarter turns around the model center", () => {
    assert.deepStrictEqual(transformPoint(createQuarterTurnTransform("x", 1), [1, 2, 3]), [1, 13, 2]);
    assert.deepStrictEqual(transformPoint(createQuarterTurnTransform("y", 1), [1, 2, 3]), [13, 2, 1]);
    assert.deepStrictEqual(transformPoint(createQuarterTurnTransform("z", 1), [1, 2, 3]), [14, 1, 3]);

    assert.deepStrictEqual(transformPoint(createQuarterTurnTransform("y", 2), [1, 2, 3]), [15, 2, 13]);
    assert.deepStrictEqual(transformPoint(createQuarterTurnTransform("y", 3), [1, 2, 3]), [3, 2, 15]);
    assert.deepStrictEqual(
      transformPoint(createQuarterTurnTransform("y", -1), [1, 2, 3]),
      transformPoint(createQuarterTurnTransform("y", 3), [1, 2, 3])
    );
    assert.throws(() => createQuarterTurnTransform("x", 0.5), /finite integer/);
  });

  it("maps face directions through each positive quarter-turn cycle", () => {
    assertDirectionCycle(createQuarterTurnTransform("x", 1), ["north", "up", "south", "down"]);
    assertDirectionCycle(createQuarterTurnTransform("y", 1), ["north", "east", "south", "west"]);
    assertDirectionCycle(createQuarterTurnTransform("z", 1), ["down", "east", "up", "west"]);

    assert.strictEqual(transformDirection(createQuarterTurnTransform("x", 1), "east"), "east");
    assert.strictEqual(transformDirection(createQuarterTurnTransform("y", 1), "up"), "up");
    assert.strictEqual(transformDirection(createQuarterTurnTransform("z", 1), "north"), "north");
  });

  it("creates single- and multi-axis mirrors with the correct determinant", () => {
    const mirrorX = createMirrorTransform("x");
    const mirrorXZ = createMirrorTransform(["x", "z"]);
    const mirrorXYZ = createMirrorTransform(["x", "y", "z"]);

    assert.deepStrictEqual(transformPoint(mirrorX, [1, 2, 3]), [15, 2, 3]);
    assert.deepStrictEqual(transformPoint(mirrorXZ, [1, 2, 3]), [15, 2, 13]);
    assert.strictEqual(transformDirection(mirrorX, "west"), "east");
    assert.strictEqual(signedPermutationDeterminant(mirrorX.matrix), -1);
    assert.strictEqual(signedPermutationDeterminant(mirrorXZ.matrix), 1);
    assert.strictEqual(signedPermutationDeterminant(mirrorXYZ.matrix), -1);
    assert.strictEqual(signedPermutationDeterminant(createQuarterTurnTransform("z", 3).matrix), 1);
  });

  it("composes translation and rotation in documented inside-out order", () => {
    const inner = createTranslationTransform([1, 0, 0]);
    const outer = createQuarterTurnTransform("y", 1);
    const composed = composeSignedPermutationTransforms(outer, inner);
    const point: ModelVec3 = [1, 2, 3];

    assert.deepStrictEqual(
      transformPoint(composed, point),
      transformPoint(outer, transformPoint(inner, point))
    );
    assert.deepStrictEqual(transformPoint(composed, point), [13, 2, 2]);
    assert.deepStrictEqual(
      transformPoint(composeSignedPermutationTransforms(inner, outer), point),
      [14, 2, 1]
    );
  });

  it("preserves directed from/to through negative axis permutations", () => {
    const northPanel = transformDirectedBounds(
      createQuarterTurnTransform("y", 1),
      [5.5, 5, -0.01],
      [10.5, 12, -0.01]
    );
    assert.deepStrictEqual(northPanel, {
      from: [16.01, 5, 5.5],
      to: [16.01, 12, 10.5]
    });

    assert.deepStrictEqual(
      transformDirectedBounds(createQuarterTurnTransform("y", 1), [12, 10, 14], [4, 2, 6]),
      { from: [10, 10, 12], to: [2, 2, 4] }
    );
    assert.deepStrictEqual(
      transformDirectedBounds(createMirrorTransform("x"), [1, 2, 3], [4, 5, 6]),
      { from: [12, 2, 3], to: [15, 5, 6] }
    );
  });
});

function assertDirectionCycle(
  transform: SignedPermutationTransform,
  cycle: readonly [ModelFaceDirection, ModelFaceDirection, ModelFaceDirection, ModelFaceDirection]
): void {
  for (let index = 0; index < cycle.length; index++) {
    assert.strictEqual(transformDirection(transform, cycle[index]), cycle[(index + 1) % cycle.length]);
  }
}
