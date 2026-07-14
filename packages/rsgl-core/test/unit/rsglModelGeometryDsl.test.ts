import * as assert from "node:assert";
import * as path from "node:path";
import {
  compileSourceWithUncheckedExterns,
  expectDiagnosticCodes,
  expectNoDiagnostics,
  unitByPath
} from "./helpers/compile";

describe("RSGL model geometry DSL", () => {
  it("lowers model geometry DSL boxes to vanilla model elements", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block fence_gate_post {",
      "  texture wood minecraft:block/oak_planks",
      "  box \"left post\" from [0, 2, 7] to [2, 13, 9] {",
      "    all texture \"#wood\"",
      "    west cullface west uv [0, 0, 2, 11]",
      "    shade false",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const model = result.units.find(unit => unit.outputPath.endsWith("fence_gate_post.json"));
    assert.deepStrictEqual(model?.content, {
      textures: {
        wood: "minecraft:block/oak_planks"
      },
      elements: [
        {
          from: [0, 2, 7],
          to: [2, 13, 9],
          shade: false,
          faces: {
            down: { texture: "#wood" },
            up: { texture: "#wood" },
            north: { texture: "#wood" },
            south: { texture: "#wood" },
            west: { texture: "#wood", cullface: "west", uv: [0, 0, 2, 11] },
            east: { texture: "#wood" }
          }
        }
      ]
    });
    const mappingPaths = model?.sourceMap.mappings.map(mapping => mapping.generatedPath) ?? [];
    assert.ok(mappingPaths.includes("/textures/wood"));
    assert.ok(mappingPaths.includes("/elements/0/from"));
    assert.ok(mappingPaths.includes("/elements/0/faces/west/cullface"));
  });

  it("maps an indexed collection texture to the selected element source", () => {
    const fileName = path.resolve("pack", "mapped-model-texture.rsgl");
    const lines = [
      "let textures = [\"minecraft:block/first\", \"minecraft:block/second\"]",
      "model block mapped_texture {",
      "  texture layer map(textures, texture => texture)[1]",
      "}"
    ];
    const source = lines.join("\n");
    const result = compileSourceWithUncheckedExterns(lines, { fileName });

    expectNoDiagnostics(result);
    const model = unitByPath(result, "models/block/mapped_texture.json");
    const origin = model.validation?.referenceOrigins?.find(candidate =>
      candidate.generatedPath === "/textures/layer"
    );
    assert.ok(origin, "Expected an exact validation origin for /textures/layer");
    assert.strictEqual(origin.sourceFile, fileName);
    assert.strictEqual(
      source.slice(origin.sourceRange.start, origin.sourceRange.end),
      "\"minecraft:block/second\""
    );
  });

  it("rotates an asymmetric panel through 0/90/180/270 with texture-following UVs", () => {
    const fileName = path.resolve("pack with space", "四向面板.rsgl");
    const lines = [
      "template northPanel() -> model {",
      "  element from [5.5, 5, -0.01] to [10.5, 12, -0.01] {",
      "    north texture \"#num\" uv [2, 3, 14, 11] rotation 90 cullface north",
      "  }",
      "}",
      "model block rotated_panel {",
      "  texture num minecraft:block/stone",
      "  for quarter in 0..3 {",
      "    transform rotate_y(quarter * 90) around [8, 8, 8] {",
      "      use northPanel()",
      "    }",
      "  }",
      "}"
    ];
    const source = lines.join("\n");
    const result = compileSourceWithUncheckedExterns(lines, { fileName });

    expectNoDiagnostics(result);
    const content = unitByPath(result, "models/block/rotated_panel.json").content;
    assert.deepStrictEqual(content, {
      textures: { num: "minecraft:block/stone" },
      elements: [
        panel([5.5, 5, -0.01], [10.5, 12, -0.01], "north"),
        panel([16.01, 5, 5.5], [16.01, 12, 10.5], "east"),
        panel([5.5, 5, 16.01], [10.5, 12, 16.01], "south"),
        panel([-0.01, 5, 5.5], [-0.01, 12, 10.5], "west")
      ]
    });
    const unit = unitByPath(result, "models/block/rotated_panel.json");
    for (const [index, direction] of ["north", "east", "south", "west"].entries()) {
      const uvMapping = unit.sourceMap.mappings.find(mapping =>
        mapping.generatedPath === `/elements/${index}/faces/${direction}/uv`
      );
      const cullfaceMapping = unit.sourceMap.mappings.find(mapping =>
        mapping.generatedPath === `/elements/${index}/faces/${direction}/cullface`
      );
      assert.strictEqual(source.slice(uvMapping?.sourceRange.start, uvMapping?.sourceRange.end), "[2, 3, 14, 11]");
      assert.strictEqual(source.slice(cullfaceMapping?.sourceRange.start, cullfaceMapping?.sourceRange.end), "north");
    }
  });

  it("supports six exact face directions and nested inside-out transforms", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block six_directions {",
      "  texture all minecraft:block/stone",
      ...directionTransform("rotate_y", 0),
      ...directionTransform("rotate_y", 90),
      ...directionTransform("rotate_y", 180),
      ...directionTransform("rotate_y", 270),
      ...directionTransform("rotate_x", 90),
      ...directionTransform("rotate_x", 270),
      "}",
      "model block nested_order {",
      "  transform rotate_y(90) around [8, 8, 8] {",
      "    transform rotate_x(90) around [8, 8, 8] {",
      "      element from [1, 2, 3] to [4, 5, 6]",
      "    }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const six = unitByPath(result, "models/block/six_directions.json").content as {
      elements: Array<{ faces: Record<string, unknown> }>;
    };
    assert.deepStrictEqual(
      six.elements.map(element => Object.keys(element.faces)[0]),
      ["north", "east", "south", "west", "up", "down"]
    );
    assert.deepStrictEqual(unitByPath(result, "models/block/nested_order.json").content, {
      elements: [{ from: [11, 10, 1], to: [14, 13, 4] }]
    });
  });

  it("keeps transform-body let shadowing lexical at runtime", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block transform_shadow {",
      "  let point = [1, 1, 1]",
      "  transform rotate_y(0) around [8, 8, 8] {",
      "    let point = [2, 2, 2]",
      "    element from point to [3, 3, 3]",
      "  }",
      "  element from point to [4, 4, 4]",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "models/block/transform_shadow.json").content, {
      elements: [
        { from: [2, 2, 2], to: [3, 3, 3] },
        { from: [1, 1, 1], to: [4, 4, 4] }
      ]
    });
  });

  it("does not expose transform-body-only lets to following model statements", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block transform_private {",
      "  transform rotate_y(0) around [8, 8, 8] {",
      "    let private_point = [2, 2, 2]",
      "    element from private_point to [3, 3, 3]",
      "  }",
      "  element from private_point to [4, 4, 4]",
      "}"
    ]);

    expectDiagnosticCodes(result, [
      "rsgl.undefinedSymbol",
      "rsgl.invalidModelElementVector"
    ]);
    assert.deepStrictEqual(unitByPath(result, "models/block/transform_private.json").content, {
      elements: [{ from: [2, 2, 2], to: [3, 3, 3] }]
    });
  });

  it("keeps inverted cuboids directed after rotate-copy", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block inverted {",
      "  transform rotate_y(90) around [8, 8, 8] {",
      "    element from [12, 10, 14] to [4, 2, 6]",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "models/block/inverted.json").content, {
      elements: [{ from: [10, 10, 12], to: [2, 2, 4] }]
    });
  });

  it("preserves materialized/remapped source mappings and validation origins", () => {
    const fileName = path.resolve("pack", "geometry-origin.rsgl");
    const lines = [
      "let cullfaces = [\"west\"]",
      "model block mapped_transform {",
      "  texture all minecraft:block/stone",
      "  transform rotate_y(90) around [0, 0, 8] {",
      "    element from [0, 0, 0] to [2, 2, 0] {",
      "      north texture \"#all\" cullface cullfaces[0] rotation 90",
      "    }",
      "  }",
      "}"
    ];
    const source = lines.join("\n");
    const result = compileSourceWithUncheckedExterns(lines, { fileName });

    expectNoDiagnostics(result);
    const unit = unitByPath(result, "models/block/mapped_transform.json");
    const cullfacePath = "/elements/0/faces/east/cullface";
    const materializedUvPath = "/elements/0/faces/east/uv";
    const rotationPath = "/elements/0/faces/east/rotation";
    const cullfaceMapping = unit.sourceMap.mappings.find(mapping => mapping.generatedPath === cullfacePath);
    const uvMapping = unit.sourceMap.mappings.find(mapping => mapping.generatedPath === materializedUvPath);
    const rotationMapping = unit.sourceMap.mappings.find(mapping => mapping.generatedPath === rotationPath);
    const validationOrigin = unit.validation?.referenceOrigins?.find(origin => origin.generatedPath === cullfacePath);
    assert.ok(uvMapping, "Expected an exact source mapping for the materialized UV field");
    assert.strictEqual(source.slice(cullfaceMapping?.sourceRange.start, cullfaceMapping?.sourceRange.end), "cullfaces[0]");
    assert.ok(source.slice(uvMapping.sourceRange.start, uvMapping.sourceRange.end).includes("north texture"));
    assert.strictEqual(source.slice(rotationMapping?.sourceRange.start, rotationMapping?.sourceRange.end), "90");
    assert.strictEqual(source.slice(validationOrigin?.sourceRange.start, validationOrigin?.sourceRange.end), "\"west\"");
  });

  it("accounts for actual and cumulative geometry expansion before allocating output", () => {
    const exactTransformBudget = compileSourceWithUncheckedExterns([
      "model block exact_budget {",
      "  transform rotate_y(90) around [8, 8, 8] {",
      "    element from [0, 0, 0] to [1, 1, 1]",
      "    element from [1, 0, 0] to [2, 1, 1]",
      "    element from [2, 0, 0] to [3, 1, 1]",
      "    element from [3, 0, 0] to [4, 1, 1]",
      "  }",
      "}"
    ], { maxEvaluationItems: 4 });
    const transformOverflow = compileSourceWithUncheckedExterns([
      "model block transform_overflow {",
      "  transform rotate_y(90) around [8, 8, 8] {",
      "    element from [0, 0, 0] to [1, 1, 1]",
      "    element from [1, 0, 0] to [2, 1, 1]",
      "    element from [2, 0, 0] to [3, 1, 1]",
      "    element from [3, 0, 0] to [4, 1, 1]",
      "  }",
      "}"
    ], { maxEvaluationItems: 3 });
    const cumulativeOverflow = compileSourceWithUncheckedExterns([
      "model block cumulative_overflow {",
      "  transform rotate_y(90) around [8, 8, 8] {",
      "    transform rotate_x(90) around [8, 8, 8] {",
      "      element from [0, 0, 0] to [1, 1, 1]",
      "    }",
      "  }",
      "}"
    ], { maxEvaluationItems: 1 });

    expectNoDiagnostics(exactTransformBudget);
    const exactContent = unitByPath(exactTransformBudget, "models/block/exact_budget.json").content as {
      elements: unknown[];
    };
    assert.strictEqual(exactContent.elements.length, 4);
    for (const result of [transformOverflow, cumulativeOverflow]) {
      const diagnostic = result.diagnostics.find(candidate =>
        candidate.code === "rsgl.geometryTransformExpansionLimit"
      );
      assert.ok(diagnostic);
      assert.strictEqual(result.units.some(unit => unit.kind === "model"), false);
    }
    assert.ok(transformOverflow.diagnostics.some(diagnostic => diagnostic.message.includes("requested 4")));
    assert.ok(cumulativeOverflow.diagnostics.some(diagnostic => diagnostic.message.includes("consumed 1")));
  });

  it("rejects invalid operation/angle/pivot, unsafe UV, and out-of-bounds output atomically", () => {
    const invalidOperation = compileSourceWithUncheckedExterns([
      "model block invalid_operation {",
      "  transform rotate_q(90) around [8, 8, 8] { element from [0, 0, 0] to [1, 1, 1] }",
      "}"
    ]);
    const invalidAngle = compileSourceWithUncheckedExterns([
      "model block invalid_angle {",
      "  transform rotate_y(45) around [8, 8, 8] { element from [0, 0, 0] to [1, 1, 1] }",
      "}"
    ]);
    const invalidPivot = compileSourceWithUncheckedExterns([
      "model block invalid_pivot {",
      "  transform rotate_y(90) around [8, 8] { element from [0, 0, 0] to [1, 1, 1] }",
      "}"
    ]);
    const invalidUv = compileSourceWithUncheckedExterns([
      "model block invalid_uv {",
      "  transform rotate_y(90) around [8, 8, 8] {",
      "    element from [0, 0, 0] to [1, 1, 1] { north texture \"#all\" rotation 45 }",
      "  }",
      "}"
    ]);
    const outOfBounds = compileSourceWithUncheckedExterns([
      "model block outside {",
      "  transform rotate_y(90) around [40, 0, 0] {",
      "    element from [0, 0, 0] to [16, 16, 16]",
      "  }",
      "}"
    ]);
    assert.deepStrictEqual(
      invalidOperation.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.invalidModelTransformOperation"]
    );
    assert.ok(invalidAngle.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidGeometryRotation"));
    assert.ok(invalidPivot.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedGeometryTransform"));
    assert.ok(invalidUv.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedGeometryUvTransform"));
    assert.ok(outOfBounds.diagnostics.some(diagnostic => diagnostic.code === "rsgl.geometryTransformOutOfBounds"));
    for (const result of [invalidOperation, invalidAngle, invalidPivot, invalidUv, outOfBounds]) {
      assert.strictEqual(result.units.some(unit => unit.kind === "model"), false);
    }
  });
});

function panel(from: number[], to: number[], direction: string) {
  return {
    from,
    to,
    faces: {
      [direction]: {
        texture: "#num",
        uv: [2, 3, 14, 11],
        rotation: 90,
        cullface: direction
      }
    }
  };
}

function directionTransform(operation: "rotate_x" | "rotate_y", angle: number): string[] {
  return [
    `  transform ${operation}(${angle}) around [8, 8, 8] {`,
    "    element from [5, 5, -0.01] to [11, 11, -0.01] {",
    "      north texture \"#all\" uv [1, 2, 15, 14] cullface north",
    "    }",
    "  }"
  ];
}
