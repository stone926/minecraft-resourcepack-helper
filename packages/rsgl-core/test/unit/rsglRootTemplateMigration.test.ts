import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  analyzeLegacyRootTemplateMigration,
  analyzeRootTemplateOperationEffects,
  applyTextEdits,
  createRootTemplateOperationProgram,
  migrateLegacyBlockstates
} from "../../src/migration";
import {
  compileRsglModule,
  stableJsonStringify,
  type JsonValue,
  type ResourceUnit
} from "../../src/compiler";
import { RsglCompiler } from "../../src/compiler/compiler";
import { parseRsgl, type RsglModule, type TemplateDeclNode, type TextRange } from "../../src/parser";
import { bindRsglModule } from "../../src/semantic";
import { withUncheckedExterns } from "./helpers/compile";

const fixtureRoot = path.resolve(
  "packages",
  "rsgl-core",
  "test",
  "fixtures",
  "abstraction-migration"
);

describe("RSGL legacy root-template migration", () => {
  it("builds a parameter-first ordered operation IR with recursive effects", () => {
    const module = parseRsgl([
      "template ordered(flag: Boolean = true) {",
      "  let local = flag",
      "  merge deep { custom: { local: local } }",
      "  for value in [false, true] {",
      "    variants { [powered=value] -> @minecraft:block/stone }",
      "  }",
      "  if flag { use nested() }",
      "}"
    ].join("\n"));
    const template = onlyTemplate(module);
    const program = createRootTemplateOperationProgram(template);
    const effects = analyzeRootTemplateOperationEffects(program);

    assert.deepStrictEqual(program.operations.map(operation => operation.kind), [
      "ParameterBinding",
      "Let",
      "RootMerge",
      "For",
      "If"
    ]);
    assert.deepStrictEqual(effects, {
      parameterCount: 1,
      defaultBindingCount: 1,
      letCount: 1,
      rootMergeCount: 1,
      rootMergeModes: ["deep"],
      modeEntryCount: 1,
      entryModes: ["variants"],
      useCount: 1,
      controlFlowCount: 2,
      unsupportedCount: 0,
      orderedKinds: [
        "ParameterBinding",
        "Let",
        "RootMerge",
        "For",
        "ModeEntry",
        "If",
        "Use"
      ]
    });
  });

  it("migrates entry-only exact root templates to public mode templates", () => {
    for (const fixture of [
      ["implicit-variants-body-template.rsgl", "explicit-variants-body-template.rsgl"],
      ["implicit-multipart-body-template.rsgl", "explicit-multipart-body-template.rsgl"]
    ] as const) {
      const legacyFile = path.join(fixtureRoot, "legacy", fixture[0]);
      const canonicalFile = path.join(fixtureRoot, "canonical", fixture[1]);
      const sourceText = fs.readFileSync(legacyFile, "utf8");
      const { result, migrated } = migrate(sourceText, legacyFile);

      assert.deepStrictEqual(result.issues, []);
      assert.strictEqual(migrated, fs.readFileSync(canonicalFile, "utf8"));
      assert.deepStrictEqual(parseRsgl(migrated).diagnostics, []);
      assert.deepStrictEqual(
        resourceProjection(compileRsglModule(parseRsgl(migrated), { fileName: canonicalFile }).units),
        resourceProjection(compileRsglModule(parseRsgl(sourceText), { fileName: legacyFile }).units)
      );
    }
  });

  it("extracts a single root merge as a typed value helper and preserves fixture output", () => {
    const legacyFile = path.join(fixtureRoot, "legacy", "root-merge-value-helper.rsgl");
    const canonicalFile = path.join(fixtureRoot, "canonical", "root-merge-value-helper.rsgl");
    const sourceText = fs.readFileSync(legacyFile, "utf8");
    const { result, migrated } = migrate(sourceText, legacyFile);

    assert.deepStrictEqual(result.issues, []);
    assert.strictEqual(migrated, fs.readFileSync(canonicalFile, "utf8"));
    assert.ok(migrated.includes("let rootMetadata: (Boolean) -> Json = enabled =>"));
    assert.ok(migrated.includes("merge deep rootMetadata(true)"));
    assert.ok(!migrated.includes("-> blockstate"));
    assert.deepStrictEqual(
      resourceProjection(compileRsglModule(parseRsgl(migrated), { fileName: canonicalFile }).units),
      resourceProjection(compileRsglModule(parseRsgl(sourceText), { fileName: legacyFile }).units)
    );
  });

  it("keeps pure local-let order and evaluates explicit glob arguments once", () => {
    const sourceText = [
      "let publicMarker = true",
      "export { publicMarker }",
      "template metadata(values: Json) {",
      "  let selected = values[0]",
      "  let payload = { custom: { selected: selected } }",
      "  merge upsert payload",
      "}",
      "blockstate variants glob_once {",
      "  use metadata(glob(\"argument\"))",
      "  {}: minecraft:block/stone",
      "}"
    ].join("\n");
    const { result, migrated } = migrate(sourceText);

    assert.deepStrictEqual(result.issues, []);
    assert.ok(migrated.includes("let metadata: (Json) -> Json = values =>"));
    assert.ok(migrated.includes("((selected) => ((payload) =>"));
    assert.ok(migrated.includes("merge upsert metadata(glob(\"argument\"))"));

    for (const source of [sourceText, migrated]) {
      const calls: string[] = [];
      const module = parseRsgl(source);
      const semantic = bindRsglModule(module, { fileName: "glob-once.rsgl" });
      const compiled = new RsglCompiler(module, {
        ...withUncheckedExterns({}),
        fileName: "glob-once.rsgl",
        namespace: "minecraft",
        stdlibTemplates: [],
        blockstateApplyFacts: semantic.blockstateApplyFacts,
        globLoader: pattern => {
          calls.push(pattern);
          return ["observed"];
        }
      }).compile();
      assert.deepStrictEqual(calls, ["argument"]);
      assert.deepStrictEqual(generatedUnits(compiled.units)[0].content, {
        custom: { selected: "observed" },
        variants: { "": { model: "minecraft:block/stone" } }
      });
    }
  });

  it("uses resolved builtin identity for value-helper effect safety", () => {
    const shadowedSource = [
      "let publicMarker = true",
      "export { publicMarker }",
      "template metadata(value: String) {",
      "  let glob = item => item",
      "  merge deep { custom: glob(value) }",
      "}",
      "blockstate variants shadowed_effect {",
      "  use metadata(\"kept\")",
      "  {}: minecraft:block/stone",
      "}"
    ].join("\n");
    const shadowed = migrate(shadowedSource);

    assert.deepStrictEqual(shadowed.result.issues, []);
    assert.ok(shadowed.migrated.includes("let metadata: (String) -> Json"));
    assert.ok(shadowed.migrated.includes("glob(value)"));

    const builtinSource = [
      "let publicMarker = true",
      "export { publicMarker }",
      "template metadata(value: String) {",
      "  merge deep { custom: glob(value) }",
      "}",
      "blockstate variants builtin_effect {",
      "  use metadata(\"kept\")",
      "  {}: minecraft:block/stone",
      "}"
    ].join("\n");
    const builtin = migrate(builtinSource);

    assert.deepStrictEqual(builtin.result.edits, []);
    assert.deepStrictEqual(builtin.result.issues.map(issue => issue.code), [
      "manualRootTemplateMigrationRequired"
    ]);
    assert.match(builtin.result.issues[0].message, /effect.*forbidden/u);
  });

  it("hygienically inlines a capture-free mixed loop without reordering merge and entry", () => {
    const sourceText = [
      "let publicMarker = true",
      "export { publicMarker }",
      "template mixed() {",
      "  for enabled in [false, true] {",
      "    merge deep { custom: { enabled: enabled } }",
      "    variants {",
      "      [powered=enabled] -> @minecraft:block/stone",
      "    }",
      "  }",
      "}",
      "blockstate variants mixed_order {",
      "  use mixed()",
      "}"
    ].join("\n");
    const { result, migrated } = migrate(sourceText);

    assert.deepStrictEqual(result.issues, []);
    assert.ok(!migrated.includes("template mixed"));
    assert.ok(!migrated.includes("use mixed"));
    assert.ok(migrated.includes([
      "for enabled in [false, true] {",
      "    merge deep { custom: { enabled: enabled } }",
      "    { powered: enabled }: minecraft:block/stone",
      "  }"
    ].join("\n")));
    assert.deepStrictEqual(
      resourceProjection(compileRsglModule(parseRsgl(migrated)).units),
      resourceProjection(compileRsglModule(parseRsgl(sourceText)).units)
    );
  });

  it("reports manual migration for defaults, exported callers, captures, and multiple merge modes", () => {
    const sources = [
      [
        "template defaults(value: Json = glob(\"default\")) {",
        "  merge deep { custom: { value: value } }",
        "}",
        "blockstate variants defaults { use defaults() }"
      ].join("\n"),
      [
        "template exported(value: Boolean) { merge deep { custom: value } }",
        "export { exported }"
      ].join("\n"),
      "template multi() { merge deep { first: true } merge strict { second: true } }",
      [
        "let captured = true",
        "template mixed() {",
        "  merge deep { custom: captured }",
        "  variants { [powered=true] -> @minecraft:block/stone }",
        "}",
        "blockstate variants captured { use mixed() }"
      ].join("\n")
    ];

    for (const sourceText of sources) {
      const module = parseRsgl(sourceText);
      const semantic = bindRsglModule(module);
      const analysis = analyzeLegacyRootTemplateMigration(onlyTemplate(module), semantic);
      const { result } = migrate(sourceText);
      assert.strictEqual(analysis.strategy, "manual", sourceText);
      assert.deepStrictEqual(result.edits, [], sourceText);
      assert.deepStrictEqual(result.issues.map(issue => issue.code), [
        "manualRootTemplateMigrationRequired"
      ], sourceText);
    }
  });

  it("rejects value-helper extraction for later local and external captures", () => {
    const sources = [
      {
        sourceText: [
          "let publicMarker = true",
          "export { publicMarker }",
          "template captured(flag: Boolean) {",
          "  let selected = later",
          "  let later = flag",
          "  merge deep { custom: selected }",
          "}",
          "blockstate variants local_capture { use captured(true) {}: minecraft:block/stone }"
        ].join("\n"),
        message: "binding 'later'"
      },
      {
        sourceText: [
          "let publicMarker = true",
          "export { publicMarker }",
          "template captured(flag: Boolean) {",
          "  merge deep { custom: externalValue }",
          "}",
          "let externalValue = true",
          "blockstate variants external_capture { use captured(true) {}: minecraft:block/stone }"
        ].join("\n"),
        message: "captures external binding 'externalValue'"
      }
    ];

    for (const { sourceText, message } of sources) {
      const { result } = migrate(sourceText);
      assert.deepStrictEqual(result.edits, [], sourceText);
      assert.deepStrictEqual(result.issues.map(issue => issue.code), [
        "manualRootTemplateMigrationRequired"
      ], sourceText);
      assert.ok(result.issues[0].message.includes(message), result.issues[0].message);
    }
  });

  it("retains definition and call provenance after value-helper extraction", () => {
    const fileName = path.join(fixtureRoot, "canonical", "root-merge-value-helper.rsgl");
    const sourceText = fs.readFileSync(fileName, "utf8");
    const result = compileRsglModule(parseRsgl(sourceText), { fileName });
    const unit = generatedUnits(result.units)[0];
    const definitionRange = rangeOf(sourceText, "{", sourceText.indexOf("rootMetadata"));
    const callRange = rangeOf(sourceText, "rootMetadata(true)");
    const argumentRange = rangeOf(sourceText, "true", callRange.start);

    const callMapping = unit.sourceMap.mappings.find(mapping =>
      mapping.generatedPath === "/custom/source"
    );
    const definitionOrigin = unit.validation?.referenceOrigins?.find(origin =>
      origin.generatedPath === "/custom/source"
    );
    const argumentOrigin = unit.validation?.referenceOrigins?.find(origin =>
      origin.generatedPath === "/custom/enabled"
    );
    assert.ok(callMapping && overlaps(callMapping.sourceRange, callRange));
    assert.ok(definitionOrigin && definitionRange.start <= definitionOrigin.sourceRange.start);
    assert.ok(argumentOrigin && overlaps(argumentOrigin.sourceRange, argumentRange));
  });
});

function migrate(sourceText: string, fileName = "<root-template-migration>") {
  const module = parseRsgl(sourceText);
  const semanticModel = bindRsglModule(module, { fileName });
  const result = migrateLegacyBlockstates({ sourceText, module, semanticModel });
  return { result, migrated: applyTextEdits(sourceText, result.edits) };
}

function onlyTemplate(module: RsglModule): TemplateDeclNode {
  const templates = module.statements.filter(
    (statement): statement is TemplateDeclNode => statement.kind === "TemplateDecl"
  );
  assert.strictEqual(templates.length, 1);
  return templates[0];
}

function generatedUnits(units: readonly ResourceUnit[]): ResourceUnit[] {
  return units.filter(unit => !unit.external && unit.content !== null);
}

function resourceProjection(units: readonly ResourceUnit[]): Array<{
  outputPath: string;
  stableJson: string;
}> {
  return generatedUnits(units).map(unit => ({
    outputPath: unit.outputPath,
    stableJson: stableJsonStringify(unit.content as JsonValue, unit.kind)
  }));
}

function rangeOf(sourceText: string, text: string, from = 0): TextRange {
  const start = sourceText.indexOf(text, from);
  assert.ok(start >= 0, `Expected source text '${text}'.`);
  return { start, end: start + text.length };
}

function overlaps(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && right.start < left.end;
}
