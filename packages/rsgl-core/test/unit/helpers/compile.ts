import * as assert from "node:assert";
import { compileRsglModule, type ResourceUnit, type RsglCompileOptions, type RsglCompileResult, type RsglEmittedFile } from "../../../src/compiler";
import { parseRsgl } from "../../../src/parser";

/** Compiles RSGL source lines as a single module, mirroring the common test idiom. */
export function compileSource(lines: readonly string[], options?: RsglCompileOptions): RsglCompileResult {
  return compileRsglModule(parseRsgl(lines.join("\n")), options);
}

/** Asserts that a compile result produced no diagnostics at all. */
export function expectNoDiagnostics(result: RsglCompileResult, message?: string): void {
  assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [], message);
}

/** Asserts the exact ordered list of diagnostic codes produced by a compile result. */
export function expectDiagnosticCodes(result: RsglCompileResult, codes: readonly string[]): void {
  assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), codes);
}

/** Finds the resource unit whose output path ends with the given path and asserts it exists. */
export function unitByPath(result: RsglCompileResult, outputPath: string): ResourceUnit {
  const unit = result.units.find(candidate => candidate.outputPath.endsWith(outputPath));
  assert.ok(unit, `Expected emitted unit for ${outputPath}`);
  return unit;
}

/** Returns the text content of an emitted file, failing for copy-only or missing files. */
export function emittedContent(file: RsglEmittedFile | undefined): string {
  if (!file || !("content" in file)) {
    throw new Error("Expected emitted content file.");
  }
  return file.content;
}
