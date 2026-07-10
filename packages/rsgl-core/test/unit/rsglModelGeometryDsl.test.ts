import * as assert from "node:assert";
import { compileSourceWithUncheckedExterns, expectNoDiagnostics } from "./helpers/compile";

describe("RSGL model geometry DSL", () => {
  it("lowers model geometry DSL boxes to vanilla model elements", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block fence_gate_post {",
      "  texture wood minecraft:block/oak_planks",
      "  box \"left post\" from [0, 2, 7] to [2, 13, 9] mirror x {",
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
        },
        {
          from: [14, 2, 7],
          to: [16, 13, 9],
          shade: false,
          faces: {
            down: { texture: "#wood" },
            up: { texture: "#wood" },
            north: { texture: "#wood" },
            south: { texture: "#wood" },
            west: { texture: "#wood" },
            east: { texture: "#wood", cullface: "east", uv: [0, 0, 2, 11] }
          }
        }
      ]
    });
    const mappingPaths = model?.sourceMap.mappings.map(mapping => mapping.generatedPath) ?? [];
    assert.ok(mappingPaths.includes("/textures/wood"));
    assert.ok(mappingPaths.includes("/elements/0/from"));
    assert.ok(mappingPaths.includes("/elements/0/faces/west/cullface"));
    assert.ok(mappingPaths.includes("/elements/1/faces/east/cullface"));
  });
});
