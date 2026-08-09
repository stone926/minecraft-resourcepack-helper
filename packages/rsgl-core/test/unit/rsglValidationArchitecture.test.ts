import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

describe("RSGL validation architecture", () => {
  it("keeps shared concerns in focused modules", () => {
    const compilerDirectory = path.join(process.cwd(), "packages", "rsgl-core", "src", "compiler");
    const focusedModules = new Set([
      "resourceReferenceValidation.ts",
      "validationDiagnostics.ts",
      "validationPrimitives.ts"
    ]);
    const concernFiles = fs.readdirSync(compilerDirectory)
      .filter(fileName => fileName === "validation.ts" || fileName.endsWith("Validation.ts"))
      .filter(fileName => !focusedModules.has(fileName));
    const sharedHelperNames = [
      "asObject",
      "isObject",
      "itemModelType",
      "atlasSourceType",
      "providerType",
      "stripMinecraftPrefix",
      "isPositiveInteger",
      "isNonNegativeInteger",
      "isFiniteNumber",
      "requireObject",
      "requireArray",
      "requireString",
      "requireBoolean",
      "requireEnum",
      "requireFiniteNumber",
      "requireNumberInRange",
      "requirePositiveInteger",
      "requirePositiveNumber",
      "validateStringField",
      "validateBooleanField",
      "validateSpecialNumberInRange",
      "validateNumberInRange",
      "attachSourceFile",
      "sourceFileForValidationRange",
      "sourceRangeForGeneratedPath",
      "unitRange",
      "pushUnitDiagnostic",
      "pushDiagnosticAtRange",
      "pushGuiScalingDiagnostic",
      "pushMcmetaDiagnostic"
    ];
    const duplicateDefinition = new RegExp(
      `(?:function|const)\\s+(?:${sharedHelperNames.join("|")})\\s*(?:=|\\()`
    );

    const duplicateOffenders = concernFiles.filter(fileName =>
      duplicateDefinition.test(fs.readFileSync(path.join(compilerDirectory, fileName), "utf8"))
    );
    const directPushOffenders = concernFiles.filter(fileName =>
      /diagnostics\.push\s*\(/.test(fs.readFileSync(path.join(compilerDirectory, fileName), "utf8"))
    );
    assert.deepStrictEqual(duplicateOffenders, []);
    assert.deepStrictEqual(directPushOffenders, []);
  });
});
