import * as assert from "node:assert";
import type { ResourceUnit, RsglCompileDiagnostic } from "../../src/compiler/ir";
import {
  attachSourceFile,
  pushDiagnosticAtRange,
  pushUnitDiagnostic
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
