import * as assert from "node:assert";
import type { ResourceUnit } from "../../src/compiler";
import { lowerItemUnitsForTarget } from "../../src/compiler/itemLegacyBackend";
import { mergeResourceUnits } from "../../src/compiler/merge";
import { validateResourceUnits } from "../../src/compiler/validation";
import {
  compileSource,
  compileSourceWithUncheckedExterns,
  expectDiagnosticCodes,
  expectNoDiagnostics,
  unitByPath
} from "./helpers/compile";

describe("RSGL resource-value metadata backends", () => {
  it("rebases observations, origins, and mappings when root arrays are appended", () => {
    const first = arrayUnit("first.rsgl", "demo:first");
    const second = arrayUnit("second.rsgl", "demo:second");

    const result = mergeResourceUnits([first, second]);

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.units.length, 1);
    assert.deepStrictEqual(
      result.units[0].validation?.resourceValueObservations?.map(item => item.generatedPath),
      ["/0/model", "/1/model"]
    );
    assert.deepStrictEqual(
      result.units[0].validation?.referenceOrigins?.map(item => item.generatedPath),
      ["/0/model", "/1/model"]
    );
    assert.deepStrictEqual(
      result.units[0].sourceMap.mappings.map(item => item.generatedPath),
      ["/0/model", "/1/model"]
    );
  });

  it("retains observations from every object fragment", () => {
    const first = objectUnit("first.rsgl", "parent", "demo:first");
    const second = objectUnit("second.rsgl", "texture", "demo:second");

    const result = mergeResourceUnits([first, second]);

    assert.deepStrictEqual(
      result.units[0].validation?.resourceValueObservations?.map(item => item.generatedPath),
      ["/parent", "/texture"]
    );
  });

  it("retains only the final observation when an object field is overwritten", () => {
    const first = objectUnit("first.rsgl", "event", "#side", "textureVariable");
    const second = objectUnit("second.rsgl", "event", "ok");
    delete second.validation;

    const result = mergeResourceUnits([first, second]);

    assert.deepStrictEqual(result.units[0].content, { event: "ok" });
    assert.strictEqual(result.units[0].validation?.resourceValueObservations, undefined);
    assert.ok(!validateResourceUnits(result.units).some(diagnostic =>
      diagnostic.code === "rsgl.textureVariableInvalidContext"
    ));
  });

  it("tracks compact equipment sugar at every final layer texture sink", () => {
    const source = [
      "namespace demo",
      "let wrong: Json = model_id(\"iron\")",
      "equipment iron {",
      "  layers [humanoid, humanoid_leggings]",
      "  texture wrong",
      "}"
    ].join("\n");
    let resolverCalls = 0;

    const result = compileSource(source.split("\n"), {
      globalExterns: [{
        source: "custom",
        kind: "texture",
        patterns: ["demo:**"],
        checkExistence: true
      }],
      externResourceExists: () => {
        resolverCalls += 1;
        return true;
      }
    });

    expectDiagnosticCodes(result, ["rsgl.resourceIdKindMismatch"]);
    assert.strictEqual(resolverCalls, 0);
    const equipment = unitByPath(result, "assets/demo/equipment/iron.json");
    assert.deepStrictEqual(
      equipment.validation?.resourceValueObservations?.map(observation => [
        observation.generatedPath,
        observation.valueKind,
        source.slice(observation.range.start, observation.range.end)
      ]),
      [
        ["/layers/humanoid/0/texture", "model", "\"iron\""],
        ["/layers/humanoid_leggings/0/texture", "model", "\"iron\""]
      ]
    );
  });

  it("compresses item composite indexes and moves scalar observations to model sinks", () => {
    const source = [
      "namespace demo",
      "let skip: Json = null",
      "let wrong: Json = texture_id(\"item/wrong\")",
      "item layered {",
      "  composite {",
      "    model skip",
      "    model wrong",
      "  }",
      "}"
    ].join("\n");
    let resolverCalls = 0;

    const result = compileSource(source.split("\n"), {
      globalExterns: [{
        source: "custom",
        kind: "model",
        patterns: ["demo:**"],
        checkExistence: true
      }],
      externResourceExists: () => {
        resolverCalls += 1;
        return true;
      }
    });

    expectDiagnosticCodes(result, [
      "rsgl.invalidItemModel",
      "rsgl.resourceIdKindMismatch"
    ]);
    assert.strictEqual(resolverCalls, 0);
    const item = unitByPath(result, "assets/demo/items/layered.json");
    assert.deepStrictEqual(
      item.validation?.resourceValueObservations?.map(observation => [
        observation.generatedPath,
        observation.valueKind,
        source.slice(observation.range.start, observation.range.end)
      ]),
      [["/model/models/0/model", "texture", "\"item/wrong\""]]
    );
    assert.deepStrictEqual(
      item.validation?.referenceOrigins?.map(origin => [
        origin.generatedPath,
        source.slice(origin.sourceRange.start, origin.sourceRange.end)
      ]),
      [["/model/models/0/model", "\"item/wrong\""]]
    );
  });

  it("moves an item model observation to the emitted legacy model path", () => {
    const source: ResourceUnit = {
      id: { namespace: "demo", path: "wand" },
      kind: "item",
      outputPath: "assets/demo/items/wand.json",
      content: {
        model: {
          type: "minecraft:model",
          model: "demo:item/other"
        }
      },
      validation: {
        resourceValueObservations: [{
          generatedPath: "/model/model",
          valueKind: "texture",
          range: { start: 10, end: 20 },
          sourceFile: "item.rsgl"
        }]
      },
      mergePolicy: { kind: "errorOnConflict" },
      sourceMap: {
        generatedFile: "assets/demo/items/wand.json",
        mappings: [{
          generatedPath: "/model/model",
          sourceFile: "item.rsgl",
          sourceRange: { start: 10, end: 20 },
          reason: "direct",
          expansionStack: []
        }]
      }
    };

    const result = lowerItemUnitsForTarget([source], { major: 64, minor: 0 });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.units.length, 1);
    assert.deepStrictEqual(result.units[0].validation?.resourceValueObservations, [{
      generatedPath: "/parent",
      valueKind: "texture",
      range: { start: 10, end: 20 },
      sourceFile: "item.rsgl"
    }]);
  });

  it("keeps branded item frames raw until each final model sink", () => {
    const source = [
      "namespace demo",
      "let frames: List<ModelId> = [\"item/first\", \"item/second\"]",
      "item wand {",
      "  range property minecraft:custom_model_data {",
      "    frames frames model frame",
      "    fallback model_id(\"item/fallback\")",
      "  }",
      "}"
    ].join("\n");

    const result = compileSourceWithUncheckedExterns(source.split("\n"));

    expectNoDiagnostics(result);
    const item = result.units.find(unit => unit.kind === "item");
    assert.ok(item);
    const observations = item.validation?.resourceValueObservations ?? [];
    assert.deepStrictEqual(
      observations.map(observation => observation.generatedPath),
      [
        "/model/entries/0/model/model",
        "/model/entries/1/model/model",
        "/model/fallback/model"
      ]
    );
    assert.deepStrictEqual(
      observations.slice(0, 2).map(observation => source.slice(
        observation.range.start,
        observation.range.end
      )),
      ["\"item/first\"", "\"item/second\""]
    );
  });
});

function arrayUnit(sourceFile: string, model: string): ResourceUnit {
  return {
    kind: "json",
    outputPath: "assets/demo/merged.json",
    content: [{ model }],
    validation: {
      referenceOrigins: [{
        generatedPath: "/0/model",
        sourceFile,
        sourceRange: { start: 0, end: 1 }
      }],
      resourceValueObservations: [{
        generatedPath: "/0/model",
        valueKind: "model",
        range: { start: 0, end: 1 },
        sourceFile
      }]
    },
    mergePolicy: { kind: "appendArray" },
    sourceMap: {
      generatedFile: "assets/demo/merged.json",
      mappings: [{
        generatedPath: "/0/model",
        sourceFile,
        sourceRange: { start: 0, end: 1 },
        reason: "direct",
        expansionStack: []
      }]
    }
  };
}

function objectUnit(
  sourceFile: string,
  key: string,
  value: string,
  valueKind: "generic" | "textureVariable" = "generic"
): ResourceUnit {
  return {
    kind: "json",
    outputPath: "assets/demo/merged-object.json",
    content: { [key]: value },
    validation: {
      resourceValueObservations: [{
        generatedPath: `/${key}`,
        valueKind,
        range: { start: 0, end: 1 },
        sourceFile
      }]
    },
    mergePolicy: { kind: "mergeObject" },
    sourceMap: {
      generatedFile: "assets/demo/merged-object.json",
      mappings: [{
        generatedPath: `/${key}`,
        sourceFile,
        sourceRange: { start: 0, end: 1 },
        reason: "direct",
        expansionStack: []
      }]
    }
  };
}
