import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResourceUnit, RsglCompileDiagnostic } from "../../src/compiler/ir";
import {
  asObject,
  pushUnitDiagnostic,
  validateBooleanField,
  validateStringField
} from "../../src/compiler/validationShared";

describe("RSGL shared validation helpers", () => {
  it("reports field diagnostics with unit and generated-path ranges", () => {
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

    assert.deepStrictEqual(diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      message: diagnostic.message,
      severity: diagnostic.severity,
      range: diagnostic.range
    })), [
      {
        code: "rsgl.invalidString",
        message: "Field 'name' must be a string.",
        severity: "error",
        range: { start: 1, end: 2 }
      },
      {
        code: "rsgl.invalidBoolean",
        message: "Option 'enabled' must be a boolean.",
        severity: "error",
        range: { start: 4, end: 5 }
      },
      {
        code: "rsgl.warning",
        message: "Warning",
        severity: "warning",
        range: { start: 1, end: 2 }
      }
    ]);
  });

  it("keeps object narrowing in the shared module", () => {
    assert.deepStrictEqual(asObject({ value: 1 }), { value: 1 });
    assert.strictEqual(asObject([]), null);
    assert.strictEqual(asObject(null), null);
  });

  it("does not reintroduce validation helper definitions in concern modules", () => {
    const compilerDirectory = path.join(process.cwd(), "packages", "rsgl-core", "src", "compiler");
    const duplicateDefinition = /function\s+(?:asObject|isObject|pushUnitDiagnostic|unitRange|validateBooleanField|validateStringField)\s*\(/;
    const offenders = fs.readdirSync(compilerDirectory)
      .filter(fileName => fileName.endsWith("Validation.ts"))
      .filter(fileName => duplicateDefinition.test(fs.readFileSync(path.join(compilerDirectory, fileName), "utf8")));

    assert.deepStrictEqual(offenders, []);
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
