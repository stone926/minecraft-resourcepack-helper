import * as assert from "node:assert";
import type { ResourceUnit, RsglCompileDiagnostic } from "../../src/compiler/ir";
import {
  attachSourceFile,
  pushDiagnosticAtRange,
  pushUnitDiagnostic,
  sourceFileForValidationRange,
  sourceRangeForGeneratedPath
} from "../../src/compiler/validationDiagnostics";
import { validateBooleanField, validateStringField } from "../../src/compiler/validationPrimitives";

describe("RSGL validation diagnostics", () => {
  it("preserves unit, generated-path, and explicit ranges", () => {
    const diagnostics: RsglCompileDiagnostic[] = [];
    const unit = createUnit();

    validateStringField({ name: 1 }, "name", "rsgl.invalidString", unit, diagnostics);
    validateBooleanField(
      { enabled: "yes" },
      "enabled",
      "rsgl.invalidBoolean",
      unit,
      diagnostics,
      { label: "Option", generatedPath: "/nested" }
    );
    pushUnitDiagnostic(diagnostics, unit, "rsgl.warning", "Warning", "warning");
    pushDiagnosticAtRange(diagnostics, "rsgl.info", "Info", "info", { start: 7, end: 8 }, "external.rsgl");
    attachSourceFile(diagnostics, 0, "example.rsgl");

    assert.deepStrictEqual(diagnostics, [
      {
        code: "rsgl.invalidString",
        message: "Field 'name' must be a string.",
        severity: "error",
        range: { start: 1, end: 2 },
        fileName: "example.rsgl"
      },
      {
        code: "rsgl.invalidBoolean",
        message: "Option 'enabled' must be a boolean.",
        severity: "error",
        range: { start: 4, end: 5 },
        fileName: "example.rsgl"
      },
      {
        code: "rsgl.warning",
        message: "Warning",
        severity: "warning",
        range: { start: 1, end: 2 },
        fileName: "example.rsgl"
      },
      {
        code: "rsgl.info",
        message: "Info",
        severity: "info",
        range: { start: 7, end: 8 },
        fileName: "external.rsgl"
      }
    ]);
  });

  it("indexes generated-path source lookups instead of rescanning every mapping", () => {
    const mappingCount = 2_000;
    const rawMappings = Array.from({ length: mappingCount }, (_, index) => ({
      generatedPath: `/variants/state=${index}/model`,
      sourceFile: `source-${index}.rsgl`,
      sourceRange: { start: index * 2 + 1, end: index * 2 + 2 },
      reason: "direct" as const,
      expansionStack: []
    }));
    let numericReads = 0;
    const mappings = new Proxy(rawMappings, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          numericReads++;
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const unit: ResourceUnit = {
      kind: "blockstate",
      outputPath: "assets/minecraft/blockstates/large.json",
      content: {},
      mergePolicy: { kind: "replace" },
      sourceMap: {
        generatedFile: "assets/minecraft/blockstates/large.json",
        mappings
      }
    };

    const firstRange = sourceRangeForGeneratedPath(unit, rawMappings[0].generatedPath);
    assert.deepStrictEqual(firstRange, rawMappings[0].sourceRange);
    const readsAfterIndexBuild = numericReads;
    assert.ok(
      readsAfterIndexBuild <= mappingCount + 1,
      `Expected one index-building pass, got ${readsAfterIndexBuild} mapping reads.`
    );

    for (const mapping of rawMappings) {
      const range = sourceRangeForGeneratedPath(unit, mapping.generatedPath);
      assert.strictEqual(range, mapping.sourceRange);
      assert.strictEqual(sourceFileForValidationRange(unit, range), mapping.sourceFile);
    }
    assert.strictEqual(
      numericReads,
      readsAfterIndexBuild,
      "Cached validation lookups must not rescan the source-map array per generated path."
    );

    const appended = {
      generatedPath: "/variants/state=appended/model",
      sourceFile: "appended.rsgl",
      sourceRange: { start: mappingCount * 2 + 1, end: mappingCount * 2 + 2 },
      reason: "direct" as const,
      expansionStack: []
    };
    rawMappings.push(appended);
    assert.strictEqual(sourceRangeForGeneratedPath(unit, appended.generatedPath), appended.sourceRange);
    assert.strictEqual(sourceFileForValidationRange(unit, appended.sourceRange), appended.sourceFile);
    assert.ok(
      numericReads <= readsAfterIndexBuild + rawMappings.length + 1,
      "Changing the mapping count should rebuild the index once."
    );
  });
});

function createUnit(): ResourceUnit {
  return {
    kind: "model",
    outputPath: "assets/minecraft/models/example.json",
    content: {},
    mergePolicy: { kind: "replace" },
    sourceMap: {
      generatedFile: "assets/minecraft/models/example.json",
      mappings: [
        {
          generatedPath: "",
          sourceFile: "example.rsgl",
          sourceRange: { start: 1, end: 2 },
          reason: "direct",
          expansionStack: []
        },
        {
          generatedPath: "/nested/enabled",
          sourceFile: "example.rsgl",
          sourceRange: { start: 4, end: 5 },
          reason: "direct",
          expansionStack: []
        }
      ]
    }
  };
}
