import * as assert from "node:assert";
import * as path from "node:path";
import {
  applyTextEdits,
  migrateLegacyBlockstateProgram,
  type RsglMigrationProgramFile
} from "../../src/migration";
import { parseRsgl } from "../../src/parser";

describe("RSGL blockstate program migration", () => {
  it("uses linked import and re-export metadata while editing only requested files", () => {
    const root = path.resolve("migration-program-test");
    const definitionsFile = path.join(root, "definitions.rsgl");
    const reexportFile = path.join(root, "public.rsgl");
    const entryFile = path.join(root, "main.rsgl");
    const definitions = [
      "template facingEntries() -> variants {",
      "  { facing: north }: minecraft:block/stone",
      "}",
      "export { facingEntries }"
    ].join("\n");
    const reexport = "export { facingEntries } from \"./definitions.rsgl\"";
    const entry = [
      "import { facingEntries } from \"./public.rsgl\"",
      "blockstate example { use facingEntries() }"
    ].join("\n");
    const files: RsglMigrationProgramFile[] = [
      { fileName: definitionsFile, module: parseRsgl(definitions) },
      { fileName: reexportFile, module: parseRsgl(reexport) },
      { fileName: entryFile, module: parseRsgl(entry), sourceText: entry }
    ];

    const result = migrateLegacyBlockstateProgram(files);

    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].fileName, entryFile);
    assert.deepStrictEqual(result.files[0].issues, []);
    assert.strictEqual(
      applyTextEdits(entry, result.files[0].edits),
      [
        "import { facingEntries } from \"./public.rsgl\"",
        "blockstate variants example { use facingEntries() }"
      ].join("\n")
    );
  });

  it("does not replace an implicitly exported root template used by another module", () => {
    const root = path.resolve("migration-program-implicit-export-test");
    const definitionsFile = path.join(root, "definitions.rsgl");
    const entryFile = path.join(root, "main.rsgl");
    const definitions = [
      "template metadata(enabled: Boolean) {",
      "  merge deep { custom: enabled }",
      "}"
    ].join("\n");
    const entry = [
      "import { metadata } from \"./definitions.rsgl\"",
      "blockstate variants example {",
      "  use metadata(true)",
      "  {}: minecraft:block/stone",
      "}"
    ].join("\n");
    const result = migrateLegacyBlockstateProgram([
      { fileName: definitionsFile, module: parseRsgl(definitions), sourceText: definitions },
      { fileName: entryFile, module: parseRsgl(entry) }
    ]);

    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].fileName, definitionsFile);
    assert.deepStrictEqual(result.files[0].edits, []);
    assert.deepStrictEqual(result.files[0].issues.map(issue => issue.code), [
      "manualRootTemplateMigrationRequired"
    ]);
    assert.ok(result.files[0].issues[0].message.includes("template is exported"));
  });
});
