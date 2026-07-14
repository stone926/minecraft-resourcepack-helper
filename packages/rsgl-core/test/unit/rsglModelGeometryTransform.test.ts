import * as assert from "node:assert";
import {
  MODEL_FACE_DIRECTIONS,
  composeSignedPermutationTransforms,
  createMirrorTransform,
  createQuarterTurnTransform,
  createTranslationTransform,
  getCanonicalFaceVertices,
  getDefaultUv,
  getFaceUvs,
  transformDirection,
  type ModelFaceDirection,
  type ModelVec3,
  type SignedPermutationTransform,
  type UvRect
} from "../../../mc-assets/src";
import type { EvaluationContext } from "../../src/compiler/evaluate";
import type { JsonValue } from "../../src/compiler/ir";
import {
  transformCompilerModelElement,
  type CompilerModelGeometryElement
} from "../../src/compiler/modelGeometryTransform";
import type { ResourceBodyMapping } from "../../src/compiler/resourceBody";

describe("RSGL model geometry transform IR", () => {
  it("mirrors asymmetric UVs, face keys, cullface, and mapping provenance together", () => {
    const context = evaluationContext();
    const cullfaceOrigin = {
      sourceFile: "E:/pack/source value.rsgl",
      sourceRange: { start: 200, end: 204 }
    };
    const source = element(
      {
        from: [0, 2, 7],
        to: [2, 13, 9],
        faces: {
          west: { texture: "#wood", uv: [0, 0, 2, 11], cullface: "west" }
        }
      },
      [
        elementMapping("/faces/west", 20, context),
        elementMapping("/faces/west/uv", 30, context),
        { ...elementMapping("/faces/west/cullface", 40, context), validationOrigin: cullfaceOrigin }
      ]
    );

    const result = transformCompilerModelElement(
      source,
      createMirrorTransform("x"),
      transformOptions(context)
    );

    assert.deepStrictEqual(result?.content, {
      from: [14, 2, 7],
      to: [16, 13, 9],
      faces: {
        east: { texture: "#wood", uv: [14, 0, 16, 11], cullface: "east" }
      }
    });
    assert.deepStrictEqual(result?.mappings.map(mapping => mapping.generatedPath), [
      "/faces/east",
      "/faces/east/uv",
      "/faces/east/cullface"
    ]);
    const cullfaceMapping = result?.mappings.find(mapping => mapping.generatedPath === "/faces/east/cullface");
    assert.deepStrictEqual(cullfaceMapping?.sourceRange, { start: 40, end: 41 });
    assert.deepStrictEqual(cullfaceMapping?.validationOrigin, cullfaceOrigin);
  });

  it("omits equivalent defaults and materializes UVs only when geometry translation changes them", () => {
    const context = evaluationContext();
    const source = element({
      from: [0, 2, 7],
      to: [2, 13, 9],
      faces: { north: { texture: "#wood" } }
    }, [elementMapping("/faces/north", 25, context)]);

    const normalMirrored = transformCompilerModelElement(
      source,
      createMirrorTransform("z"),
      transformOptions(context)
    );
    assert.deepStrictEqual(normalMirrored?.content.faces, {
      south: { texture: "#wood" }
    });

    const tangentialSource = element({
      from: [1, 2, 3],
      to: [4, 5, 6],
      faces: { north: { texture: "#wood" } }
    }, [elementMapping("/faces/north", 35, context)]);
    const tangentialMirror = transformCompilerModelElement(
      tangentialSource,
      createMirrorTransform("x"),
      transformOptions(context)
    );
    assert.deepStrictEqual(tangentialMirror?.content.faces, {
      north: { texture: "#wood" }
    });
    assert.strictEqual(
      tangentialMirror?.mappings.some(mapping => mapping.generatedPath === "/faces/north/uv"),
      false
    );

    const translated = transformCompilerModelElement(
      source,
      createTranslationTransform([2, 0, 0]),
      transformOptions(context)
    );
    assert.deepStrictEqual(translated?.content.faces, {
      north: { texture: "#wood", uv: [14, 3, 16, 14] }
    });
    assert.deepStrictEqual(
      translated?.mappings.find(mapping => mapping.generatedPath === "/faces/north/uv")?.sourceRange,
      { start: 25, end: 26 }
    );
  });

  it("keeps omitted and explicit-default source faces corner-equivalent", () => {
    const context = evaluationContext();
    const cases = [
      {
        content: { from: [1, 2, 3], to: [4, 5, 6] },
        sourceDirection: "north" as const,
        targetDirection: "north" as const,
        sourceDefault: [12, 11, 15, 14] as UvRect,
        transform: createMirrorTransform("x")
      },
      {
        content: { from: [0, 0, 0], to: [2, 16, 2] },
        sourceDirection: "north" as const,
        targetDirection: "south" as const,
        sourceDefault: [14, 0, 16, 16] as UvRect,
        transform: createMirrorTransform("z")
      }
    ];

    for (const testCase of cases) {
      const omitted = transformCompilerModelElement(
        element({
          ...testCase.content,
          faces: { [testCase.sourceDirection]: { texture: "#all" } }
        }),
        testCase.transform,
        transformOptions(context)
      );
      const explicit = transformCompilerModelElement(
        element({
          ...testCase.content,
          faces: { [testCase.sourceDirection]: { texture: "#all", uv: testCase.sourceDefault } }
        }),
        testCase.transform,
        transformOptions(context)
      );

      assert.ok(omitted);
      assert.ok(explicit);
      assert.deepStrictEqual(
        decodedFaceCorners(omitted, testCase.targetDirection),
        decodedFaceCorners(explicit, testCase.targetDirection)
      );
    }
  });

  it("composes signed-permutation UV transforms without changing vertex-to-UV semantics", () => {
    const context = evaluationContext();
    const transforms: Array<{ name: string; value: SignedPermutationTransform }> = [
      ...(["x", "y", "z"] as const).flatMap(axis => [1, 2, 3].map(quarterTurns => ({
        name: `rotate_${axis}_${quarterTurns}`,
        value: createQuarterTurnTransform(axis, quarterTurns)
      }))),
      ...([
        ["x"], ["y"], ["z"],
        ["x", "y"], ["x", "z"], ["y", "z"],
        ["x", "y", "z"]
      ] as const).map(axes => ({
        name: `mirror_${axes.join("")}`,
        value: createMirrorTransform(axes)
      }))
    ];

    for (const sourceDirection of MODEL_FACE_DIRECTIONS) {
      for (const rotation of [0, 90, 180, 270] as const) {
        const source = element({
          from: [1, 2, 3],
          to: [5, 7, 11],
          faces: {
            [sourceDirection]: { texture: "#all", uv: [1, 2, 13, 15], rotation }
          }
        });
        for (const inner of transforms) {
          for (const outer of transforms) {
            const sequentialInner = transformCompilerModelElement(source, inner.value, transformOptions(context));
            const sequential = sequentialInner
              ? transformCompilerModelElement(sequentialInner, outer.value, transformOptions(context))
              : undefined;
            const composedTransform = composeSignedPermutationTransforms(outer.value, inner.value);
            const composed = transformCompilerModelElement(source, composedTransform, transformOptions(context));
            const finalDirection = transformDirection(composedTransform, sourceDirection);
            const caseName = `${sourceDirection}/${rotation}/${inner.name}/${outer.name}`;

            assert.ok(sequential, `Expected sequential transform for ${caseName}`);
            assert.ok(composed, `Expected composed transform for ${caseName}`);
            assert.deepStrictEqual(
              [sequential.content.from, sequential.content.to],
              [composed.content.from, composed.content.to],
              `Directed bounds differ for ${caseName}`
            );
            assert.deepStrictEqual(
              Object.keys(sequential.content.faces as Record<string, unknown>),
              [finalDirection],
              `Sequential face direction differs for ${caseName}`
            );
            assert.deepStrictEqual(
              Object.keys(composed.content.faces as Record<string, unknown>),
              [finalDirection],
              `Composed face direction differs for ${caseName}`
            );
            assert.deepStrictEqual(
              canonicalUvAssignments(sequential, finalDirection),
              canonicalUvAssignments(composed, finalDirection),
              `Vertex-to-UV assignments differ for ${caseName}`
            );
          }
        }
      }
    }
  });

  it("matches the scaffolding asymmetric north-to-south UV golden", () => {
    const context = evaluationContext();
    const source = element({
      from: [0, 0, 0],
      to: [2, 16, 2],
      faces: { north: { texture: "#side", uv: [14, 0, 16, 16] } }
    });
    const mirrored = transformCompilerModelElement(source, createMirrorTransform("z"), transformOptions(context));
    assert.deepStrictEqual(mirrored?.content, {
      from: [0, 0, 14],
      to: [2, 16, 16],
      faces: { south: { texture: "#side", uv: [0, 0, 2, 16] } }
    });
  });

  it("transforms top/down UV rotation and cullface as exact four-corner data", () => {
    const context = evaluationContext();
    const transformed = transformCompilerModelElement(
      element({
        from: [1, 2, 3],
        to: [4, 5, 6],
        faces: {
          up: { texture: "#top", uv: [1, 2, 7, 9], rotation: 90, cullface: "up" },
          down: { texture: "#bottom", uv: [3, 4, 11, 13], rotation: 270, cullface: "down" }
        }
      }),
      createQuarterTurnTransform("x", 1),
      transformOptions(context)
    );

    assert.deepStrictEqual(transformed?.content, {
      from: [1, 10, 2],
      to: [4, 13, 5],
      faces: {
        north: { texture: "#bottom", uv: [5, 3, 13, 12], rotation: 270, cullface: "north" },
        south: { texture: "#top", uv: [1, 2, 7, 9], rotation: 90, cullface: "south" }
      }
    });
  });

  it("preserves directed inverted bounds through exact quarter turns", () => {
    const context = evaluationContext();
    const result = transformCompilerModelElement(
      element({ from: [12, 10, 14], to: [4, 2, 6] }),
      createQuarterTurnTransform("y", 1),
      transformOptions(context)
    );
    assert.deepStrictEqual(result?.content, {
      from: [10, 10, 12],
      to: [2, 2, 4]
    });
  });

  it("conjugates element rotations using the full transform determinant", () => {
    const context = evaluationContext();
    const source = element({
      from: [1, 2, 3],
      to: [4, 5, 6],
      rotation: { origin: [8, 8, 8], axis: "y", angle: 22.5, rescale: true }
    });

    const mirroredX = transformCompilerModelElement(source, createMirrorTransform("x"), transformOptions(context));
    const mirroredXZ = transformCompilerModelElement(source, createMirrorTransform(["x", "z"]), transformOptions(context));
    assert.deepStrictEqual(mirroredX?.content.rotation, {
      origin: [8, 8, 8], axis: "y", angle: -22.5, rescale: true
    });
    assert.deepStrictEqual(mirroredXZ?.content.rotation, {
      origin: [8, 8, 8], axis: "y", angle: 22.5, rescale: true
    });

    const negativeAxisSource = element({
      from: [1, 2, 3],
      to: [4, 5, 6],
      rotation: { origin: [2, 3, 4], axis: "z", angle: 22.5 }
    });
    const quarterTurned = transformCompilerModelElement(
      negativeAxisSource,
      createQuarterTurnTransform("y", 1),
      transformOptions(context)
    );
    const mirroredZ = transformCompilerModelElement(
      negativeAxisSource,
      createMirrorTransform("z"),
      transformOptions(context)
    );
    assert.deepStrictEqual(quarterTurned?.content.rotation, {
      origin: [12, 3, 2], axis: "x", angle: -22.5
    });
    assert.deepStrictEqual(mirroredZ?.content.rotation, {
      origin: [2, 3, 12], axis: "z", angle: 22.5
    });
  });

  it("preserves content and provenance exactly for a zero-degree identity transform", () => {
    const context = evaluationContext();
    const validationOrigin = {
      sourceFile: "E:/pack/identity-origin.rsgl",
      sourceRange: { start: 50, end: 55 }
    };
    const source = element(
      {
        from: [1, 2, 3],
        to: [4, 5, 6],
        faces: { north: { texture: "#all", uv: [2, 3, 14, 11], rotation: 90 } }
      },
      [{ ...elementMapping("/faces/north/uv", 45, context), validationOrigin }]
    );
    const transformed = transformCompilerModelElement(
      source,
      createQuarterTurnTransform("z", 0, [2, 3, 4]),
      transformOptions(context)
    );

    assert.deepStrictEqual(transformed, source);
    assert.notStrictEqual(transformed?.content, source.content);
    assert.notStrictEqual(transformed?.mappings[0], source.mappings[0]);
  });

  it("atomically rejects invalid face data and out-of-bounds results", () => {
    const context = evaluationContext();
    const diagnostics: string[] = [];
    const options = {
      ...transformOptions(context),
      onError: (code: string) => diagnostics.push(code)
    };
    const invalidUv = transformCompilerModelElement(
      element({
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: { north: { texture: "#all", uv: [0, 0, 16], rotation: 45 } }
      }),
      createMirrorTransform("x"),
      options
    );
    const invalidFace = transformCompilerModelElement(
      element({
        from: [0, 0, 0],
        to: [1, 1, 1],
        faces: { diagonal: { texture: "#all" } }
      }),
      createMirrorTransform("x"),
      options
    );
    const invalidCullface = transformCompilerModelElement(
      element({
        from: [0, 0, 0],
        to: [1, 1, 1],
        faces: { north: { texture: "#all", cullface: "diagonal" } }
      }),
      createMirrorTransform("x"),
      options
    );
    const outOfBounds = transformCompilerModelElement(
      element({ from: [0, 0, 0], to: [16, 16, 16] }),
      createTranslationTransform([40, 0, 0]),
      options
    );

    assert.strictEqual(invalidUv, undefined);
    assert.strictEqual(invalidFace, undefined);
    assert.strictEqual(invalidCullface, undefined);
    assert.strictEqual(outOfBounds, undefined);
    assert.deepStrictEqual(diagnostics, [
      "rsgl.unsupportedGeometryUvTransform",
      "rsgl.invalidFaceDirection",
      "rsgl.invalidFaceDirection",
      "rsgl.geometryTransformOutOfBounds"
    ]);
  });
});

function evaluationContext(): EvaluationContext {
  return {
    namespace: "minecraft",
    variables: new Map(),
    sourceFile: "E:/pack/model geometry.rsgl"
  };
}

function element(
  content: Record<string, JsonValue>,
  mappings: ResourceBodyMapping[] = []
): CompilerModelGeometryElement {
  return { content, mappings };
}

function elementMapping(
  generatedPath: string,
  start: number,
  context: EvaluationContext
): ResourceBodyMapping {
  return {
    generatedPath,
    sourceRange: { start, end: start + 1 },
    context
  };
}

function transformOptions(context: EvaluationContext) {
  return {
    fallbackRange: { start: 0, end: 1 },
    context
  };
}

function decodedFaceCorners(
  element: CompilerModelGeometryElement,
  direction: ModelFaceDirection
): ReturnType<typeof getFaceUvs> {
  const from = element.content.from as ModelVec3;
  const to = element.content.to as ModelVec3;
  const faces = element.content.faces as Record<string, { uv?: UvRect; rotation?: number }>;
  const face = faces[direction];
  return getFaceUvs(face.uv ?? getDefaultUv(direction, from, to), face.rotation ?? 0);
}

function canonicalUvAssignments(
  element: CompilerModelGeometryElement,
  direction: ModelFaceDirection
): Array<{ vertex: ModelVec3; uv: [number, number] }> {
  const from = element.content.from as ModelVec3;
  const to = element.content.to as ModelVec3;
  const corners = decodedFaceCorners(element, direction);
  return getCanonicalFaceVertices(direction, from, to)
    .map((vertex, index) => ({ vertex, uv: corners[index] }))
    .sort((left, right) => compareModelVectors(left.vertex, right.vertex));
}

function compareModelVectors(left: ModelVec3, right: ModelVec3): number {
  for (let index = 0; index < 3; index++) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
