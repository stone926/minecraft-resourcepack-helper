import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyTextEdits,
  migrateLegacyBlockstates,
  type MigrationResult
} from "../../src/migration";
import {
  compileRsglModule,
  stableJsonStringify,
  type JsonValue
} from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { walkRsglModule } from "../../src/parser/astTraversal";
import { bindRsglModule } from "../../src/semantic";

const fixtureRoot = path.resolve(
  "packages",
  "rsgl-core",
  "test",
  "fixtures",
  "abstraction-migration"
);

describe("RSGL blockstate source migration", () => {
  it("migrates the frozen direct variants/multipart fixture to canonical source", () => {
    const legacyFile = path.join(fixtureRoot, "legacy", "direct-blockstate-modes.rsgl");
    const canonicalFile = path.join(fixtureRoot, "canonical", "direct-blockstate-modes.rsgl");
    const sourceText = fs.readFileSync(legacyFile, "utf8");
    const { result, migrated } = migrate(sourceText, legacyFile);

    assert.deepStrictEqual(result.issues, []);
    assert.strictEqual(migrated, fs.readFileSync(canonicalFile, "utf8"));
    assert.strictEqual(result.edits.length, 4);
    assert.deepStrictEqual(result.edits.filter(edit => edit.range.start === edit.range.end).map(edit => edit.newText), [
      " variants",
      " multipart"
    ]);
    assert.deepStrictEqual(result.edits.filter(edit => edit.range.start !== edit.range.end).map(edit =>
      sourceText.slice(edit.range.start, edit.range.end).trimStart().split(/\s/u, 1)[0]
    ), ["variants", "multipart"]);

    const canonicalModule = parseRsgl(migrated);
    assert.deepStrictEqual(canonicalModule.diagnostics, []);
    const blockstates = canonicalModule.statements.filter(statement =>
      statement.kind === "ResourceDecl" && statement.resourceKind === "blockstate"
    );
    assert.deepStrictEqual(blockstates.map(resource =>
      resource.kind === "ResourceDecl" && resource.resourceKind === "blockstate"
        ? [resource.blockstateSyntax, resource.mode, resource.body.kind]
        : []
    ), [
      ["modeHeader", "variants", "BlockstateVariantsRootBody"],
      ["modeHeader", "multipart", "BlockstateMultipartRootBody"]
    ]);
    assertNoLegacyBlockstateSyntax(canonicalModule);

    const legacyCompile = compileRsglModule(parseRsgl(sourceText), { fileName: legacyFile });
    const canonicalCompile = compileRsglModule(canonicalModule, { fileName: canonicalFile });
    assert.deepStrictEqual(
      resourceProjection(canonicalCompile.units),
      resourceProjection(legacyCompile.units),
      "migration must preserve outputPath and stable JSON"
    );
  });

  it("uses the exact legacy template-parameter alias contract for computed selector keys", () => {
    const sourceText = [
      "import { imported } from \"./values.rsgl\"",
      "template make(key: String) {",
      "  blockstate example {",
      "    variants {",
      "      [key=true] -> @minecraft:block/stone uvlock",
      "      [facing=north] -> @minecraft:block/stone",
      "      let local = \"powered\"",
      "      [local=true] -> @minecraft:block/stone",
      "      [imported=true] -> @minecraft:block/stone",
      "      for facing in [\"north\"] {",
      "        [facing=facing] -> @minecraft:block/stone",
      "      }",
      "      for key in [\"powered\"] {",
      "        [key=true] -> @minecraft:block/stone",
      "      }",
      "    }",
      "  }",
      "}"
    ].join("\n");
    const { result, migrated } = migrate(sourceText);

    assert.deepStrictEqual(result.issues, []);
    assert.ok(migrated.includes("blockstate variants example"));
    assert.ok(migrated.includes("{ [key]: true }: minecraft:block/stone uvlock=true"));
    assert.ok(migrated.includes("{ facing: north }: minecraft:block/stone"));
    assert.ok(!migrated.includes("{ [facing]"));
    assert.ok(migrated.includes("{ local: true }: minecraft:block/stone"));
    assert.ok(migrated.includes("{ imported: true }: minecraft:block/stone"));
    assert.ok(migrated.includes("{ facing: facing }: minecraft:block/stone"));
    assert.strictEqual((migrated.match(/\{ \[key\]: true \}/gu) ?? []).length, 2);
    assertNoLegacyBlockstateSyntax(parseRsgl(migrated));
  });

  it("infers wrapper-less modes from public uses, static merges, and direct entries", () => {
    const sourceText = [
      "template variantEntries() -> variants {}",
      "template multipartEntries() -> multipart {}",
      "blockstate from_variant_use { use variantEntries() }",
      "blockstate from_multipart_use { use multipartEntries() }",
      "blockstate from_merge { merge deep { variants: patch } }",
      "blockstate direct_variant { [facing=north] -> @minecraft:block/stone uvlock }",
      "blockstate direct_multipart { apply @minecraft:block/stone }"
    ].join("\n");
    const { result, migrated } = migrate(sourceText);

    assert.deepStrictEqual(result.issues, []);
    for (const header of [
      "blockstate variants from_variant_use",
      "blockstate multipart from_multipart_use",
      "blockstate variants from_merge",
      "blockstate variants direct_variant",
      "blockstate multipart direct_multipart"
    ]) {
      assert.ok(migrated.includes(header), `Expected inferred header ${header}`);
    }
    assert.ok(migrated.includes("{ facing: north }: minecraft:block/stone uvlock=true"));
    assert.ok(migrated.includes("apply minecraft:block/stone"));
  });

  it("migrates an entry-only legacy root template to an explicit mode template", () => {
    const sourceText = [
      "template root() { variants { [facing=north] -> @minecraft:block/stone } }",
      "blockstate from_exact { use root() }"
    ].join("\n");
    const { result, migrated } = migrate(sourceText);

    assert.deepStrictEqual(result.issues, []);
    assert.ok(migrated.includes("blockstate variants from_exact"));
    assert.ok(migrated.includes("template root() -> variants {"));
    assert.ok(migrated.includes("{ facing: north }: minecraft:block/stone"));
    assertNoLegacyBlockstateSyntax(parseRsgl(migrated));
  });

  it("preserves comments and control-flow order while removing wrapper syntax", () => {
    const sourceText = [
      "blockstate commented {",
      "  // before wrapper",
      "  variants { // wrapper mode",
      "    // before entry",
      "    [facing /* equals */ = north] -> @minecraft:block/stone uvlock // entry",
      "    for key in [\"powered\"] {",
      "      [key=true] -> @minecraft:block/stone",
      "    }",
      "  } // after wrapper",
      "}"
    ].join("\n");
    const { result, migrated } = migrate(sourceText);

    assert.deepStrictEqual(result.issues, []);
    for (const comment of [
      "// before wrapper",
      "// wrapper mode",
      "// before entry",
      "/* equals */",
      "// entry",
      "// after wrapper"
    ]) {
      assert.ok(migrated.includes(comment), `Expected migration to preserve ${comment}`);
    }
    assert.ok(migrated.indexOf("// before entry") < migrated.indexOf("for key"));
    assert.ok(migrated.includes("{ key: true }: minecraft:block/stone"));
    assert.ok(!migrated.includes("variants {"));
  });

  it("preserves conditional legacy ids and their compiled outputs", () => {
    const sourceText = [
      "for type in [\"nest\", \"hive\"] {",
      "  blockstate type == \"nest\" ? \"bee_nest\" : \"beehive\" {",
      "    variants { [facing=north] -> @minecraft:block/stone }",
      "  }",
      "}"
    ].join("\n");
    const { result, migrated } = migrate(sourceText);

    assert.deepStrictEqual(result.issues, []);
    assert.ok(migrated.includes("blockstate variants type == \"nest\" ? \"bee_nest\" : \"beehive\""));
    assert.deepStrictEqual(
      resourceProjection(compileRsglModule(parseRsgl(migrated)).units),
      resourceProjection(compileRsglModule(parseRsgl(sourceText)).units)
    );
  });

  it("migrates legacy syntax nested under an existing mode header without inserting another mode", () => {
    const sourceText = [
      "blockstate variants already_typed {",
      "  variants {",
      "    [facing=north] -> @minecraft:block/stone uvlock",
      "  }",
      "}"
    ].join("\n");
    const { result, migrated } = migrate(sourceText);

    assert.deepStrictEqual(result.issues, []);
    assert.ok(result.edits.length > 0);
    assert.ok(result.edits.every(edit => edit.newText !== " variants"));
    assert.strictEqual((migrated.match(/blockstate variants/gu) ?? []).length, 1);
    assert.ok(migrated.includes("{ facing: north }: minecraft:block/stone uvlock=true"));
    assert.ok(!migrated.includes("  variants {"));
    assertNoLegacyBlockstateSyntax(parseRsgl(migrated));
    assert.deepStrictEqual(
      resourceProjection(compileRsglModule(parseRsgl(migrated)).units),
      resourceProjection(compileRsglModule(parseRsgl(sourceText)).units)
    );
  });

  it("returns issues and no risky edits when mode or root-template lowering is not proven", () => {
    const cases: Array<{ source: string; codes: string[] }> = [
      {
        source: "blockstate empty {}",
        codes: ["blockstateModeSelectionRequired"]
      },
      {
        source: "blockstate custom { custom: true }",
        codes: ["blockstateModeSelectionRequired"]
      },
      {
        source: "blockstate dynamic { merge patch }",
        codes: ["blockstateModeSelectionRequired"]
      },
      {
        source: "blockstate conflict { variants {} multipart {} }",
        codes: ["blockstateModeConflict"]
      },
      {
        source: [
          "template contextual() { let value = 1 }",
          "blockstate neutral { use contextual() }"
        ].join("\n"),
        codes: ["blockstateModeSelectionRequired"]
      },
      {
        source: "template root() { merge deep { custom: true } merge strict { other: true } }",
        codes: ["manualRootTemplateMigrationRequired"]
      }
    ];

    for (const item of cases) {
      const { result } = migrate(item.source);
      assert.deepStrictEqual(result.edits, [], item.source);
      assert.deepStrictEqual(result.issues.map(issue => issue.code), item.codes, item.source);
    }
  });

  it("keeps TextEdit application transport-neutral and rejects overlaps", () => {
    assert.strictEqual(applyTextEdits("abcdef", [
      { range: { start: 1, end: 3 }, newText: "X" },
      { range: { start: 5, end: 5 }, newText: "!" }
    ]), "aXde!f");
    assert.throws(() => applyTextEdits("abcdef", [
      { range: { start: 1, end: 4 }, newText: "" },
      { range: { start: 3, end: 5 }, newText: "" }
    ]), /must not overlap/u);
  });
});

function migrate(sourceText: string, fileName = "<migration-test>"): {
  result: MigrationResult;
  migrated: string;
} {
  const module = parseRsgl(sourceText);
  const semanticModel = bindRsglModule(module, { fileName });
  const result = migrateLegacyBlockstates({ sourceText, module, semanticModel });
  return { result, migrated: applyTextEdits(sourceText, result.edits) };
}

function assertNoLegacyBlockstateSyntax(module: ReturnType<typeof parseRsgl>): void {
  const legacyKinds: string[] = [];
  walkRsglModule(module, {
    enterStatement(statement) {
      if (statement.kind === "VariantsSection"
        || statement.kind === "MultipartSection"
        || statement.kind === "VariantEntry"
        || statement.kind === "MultipartEntry") {
        legacyKinds.push(statement.kind);
      }
    },
    enterExpression(expression) {
      if (expression.kind === "StateKeySugar" || expression.kind === "ModelApplySugar") {
        legacyKinds.push(expression.kind);
      }
    }
  });
  assert.deepStrictEqual(legacyKinds, []);
}

function resourceProjection(
  units: ReturnType<typeof compileRsglModule>["units"]
): Array<{ outputPath: string; stableJson: string }> {
  return units.map(unit => ({
    outputPath: unit.outputPath,
    stableJson: stableJsonStringify(unit.content as JsonValue, unit.kind)
  }));
}
