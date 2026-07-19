import * as assert from "node:assert";
import * as path from "node:path";
import { compileRsglModule } from "../../src/compiler/compilePipeline";
import { generatedResourceKeysForUnit } from "../../src/compiler/generatedResources";
import type { ResourceUnit } from "../../src/compiler/ir";
import {
  createRsglResourceNavigationIndex,
  getRsglResourceDefinitionLocationsAtOffset,
  getRsglResourceReferenceLocationsAtOffset
} from "../../src/compiler/resourceNavigation";
import type { RsglResourceReferenceUsage } from "../../src/compiler/validationTypes";
import { parseRsgl } from "../../src/parser";

describe("RSGL resource navigation", () => {
  it("indexes canonical namespace/model-subtype identities through dynamic template loops", () => {
    const fileName = path.resolve("resource-navigation-dynamic.rsgl");
    const source = [
      "namespace nav",
      "template emit(id: String) {",
      "  model block id {}",
      "}",
      "for id in [stone, dirt] {",
      "  use emit(id)",
      "}",
      "blockstate variants stone_state { case * => nav:block/stone }",
      "blockstate variants dirt_state { case * => nav:block/dirt }"
    ].join("\n");
    const references: RsglResourceReferenceUsage[] = [];
    const result = compileRsglModule(parseRsgl(source), {
      fileName,
      onResourceReferenceUsed: reference => references.push(reference)
    });
    assert.deepStrictEqual(
      result.diagnostics.filter(diagnostic => diagnostic.severity === "error").map(diagnostic => diagnostic.code),
      []
    );

    const index = createRsglResourceNavigationIndex(result.units, references);
    const definitionStart = source.indexOf("id {}", source.indexOf("model block"));
    const definitionRange = { start: definitionStart, end: definitionStart + 2 };
    const stoneReferenceStart = source.indexOf("nav:block/stone");
    const dirtReferenceStart = source.indexOf("nav:block/dirt");

    assert.deepStrictEqual(
      getRsglResourceDefinitionLocationsAtOffset(index, fileName, stoneReferenceStart + 2),
      [{ fileName, range: definitionRange }]
    );
    assert.deepStrictEqual(
      getRsglResourceReferenceLocationsAtOffset(index, fileName, definitionStart + 1, false),
      [
        {
          fileName,
          range: { start: stoneReferenceStart, end: stoneReferenceStart + "nav:block/stone".length }
        },
        {
          fileName,
          range: { start: dirtReferenceStart, end: dirtReferenceStart + "nav:block/dirt".length }
        }
      ]
    );
    assert.deepStrictEqual(
      getRsglResourceReferenceLocationsAtOffset(index, fileName, definitionStart + 1, true),
      [
        { fileName, range: definitionRange },
        {
          fileName,
          range: { start: stoneReferenceStart, end: stoneReferenceStart + "nav:block/stone".length }
        },
        {
          fileName,
          range: { start: dirtReferenceStart, end: dirtReferenceStart + "nav:block/dirt".length }
        }
      ]
    );
  });

  it("keeps identical canonical ids isolated by resource kind", () => {
    const fileName = path.resolve("resource-navigation-kinds.rsgl");
    const item = resourceUnit("item", "assets/nav/items/shared.json", fileName, { start: 0, end: 6 });
    const blockstate = resourceUnit(
      "blockstate",
      "assets/nav/blockstates/shared.json",
      fileName,
      { start: 10, end: 20 }
    );
    const references: RsglResourceReferenceUsage[] = [
      { targetKind: "item", id: "nav:shared", sourceFile: fileName, range: { start: 30, end: 40 } },
      { targetKind: "blockstate", id: "nav:shared", sourceFile: fileName, range: { start: 50, end: 60 } }
    ];
    const index = createRsglResourceNavigationIndex([item, blockstate], references);

    assert.deepStrictEqual(
      getRsglResourceDefinitionLocationsAtOffset(index, fileName, 35),
      [{ fileName, range: { start: 0, end: 6 } }]
    );
    assert.deepStrictEqual(
      getRsglResourceDefinitionLocationsAtOffset(index, fileName, 55),
      [{ fileName, range: { start: 10, end: 20 } }]
    );
  });

  it("does not treat ordinary JSON strings as resource references", () => {
    const fileName = path.resolve("resource-navigation-json.rsgl");
    const source = [
      "namespace nav",
      "model block stone {}",
      "json \"assets/nav/custom/plain.json\" {",
      "  value \"nav:block/stone\"",
      "}"
    ].join("\n");
    const references: RsglResourceReferenceUsage[] = [];
    const result = compileRsglModule(parseRsgl(source), {
      fileName,
      onResourceReferenceUsed: reference => references.push(reference)
    });
    const index = createRsglResourceNavigationIndex(result.units, references);
    const plainStringStart = source.indexOf("nav:block/stone");

    assert.deepStrictEqual(
      getRsglResourceDefinitionLocationsAtOffset(index, fileName, plainStringStart + 2),
      []
    );
    assert.deepStrictEqual(
      getRsglResourceReferenceLocationsAtOffset(index, fileName, plainStringStart + 2, true),
      []
    );
  });

  it("preserves declaration origins through legacy item lowering", () => {
    const fileName = path.resolve("resource-navigation-legacy.rsgl");
    const source = [
      "target java format 43",
      "namespace nav",
      "item wand { model nav:block/wand }",
      "model block wand {}"
    ].join("\n");
    const result = compileRsglModule(parseRsgl(source), { fileName });
    const lowered = result.units.find(unit =>
      generatedResourceKeysForUnit(unit).some(key =>
        key.kind === "model" && key.id === "nav:item/wand"
      )
    );
    const definitionStart = source.indexOf("wand", source.indexOf("item wand"));

    assert.ok(lowered);
    assert.deepStrictEqual(lowered.validation?.resourceDefinitionOrigins, [{
      sourceFile: fileName,
      sourceRange: { start: definitionStart, end: definitionStart + "wand".length }
    }]);
  });
});

function resourceUnit(
  kind: "item" | "blockstate",
  outputPath: string,
  sourceFile: string,
  sourceRange: { start: number; end: number }
): ResourceUnit {
  return {
    kind,
    id: { namespace: "nav", path: "shared" },
    outputPath,
    content: {},
    validation: {
      resourceDefinitionOrigins: [{ sourceFile, sourceRange }]
    },
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: { generatedFile: outputPath, mappings: [] }
  };
}
