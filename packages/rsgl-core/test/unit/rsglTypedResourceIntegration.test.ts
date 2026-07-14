import * as assert from "node:assert";
import * as path from "node:path";
import {
  compileRsglProgram,
  type JsonValue,
  type ResourceUnit
} from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import {
  compileSource,
  expectNoDiagnostics,
  unitByPath,
  withUncheckedExterns
} from "./helpers/compile";

describe("RSGL typed resource integration", () => {
  it("keeps typed lets, template boundaries, nested containers, and imports namespace-stable", () => {
    const root = path.resolve("typed id 集成 with spaces");
    const mainFile = path.join(root, "main pack.rsgl");
    const libraryFile = path.join(root, "资源 库.rsgl");
    const mainSource = [
      "namespace caller",
      "import { emit, exported } from \"./资源 库.rsgl\"",
      "let suffix = \"dynamic\"",
      "let direct: ModelId = `block/${suffix}`",
      "use emit(`block/${suffix}`)",
      "json \"assets/caller/direct.json\" {",
      "  direct direct",
      "  imported exported",
      "}"
    ].join("\n");
    const librarySource = [
      "namespace library",
      "type Bundle = {",
      "  model: ModelId",
      "  optional?: ModelId",
      "  textures: List<TextureId>",
      "  choice: ModelId | Number",
      "}",
      "let exported: Bundle = {",
      "  model: \"block/library_model\"",
      "  optional: \"block/library_optional\"",
      "  textures: [\"block/library_texture\"]",
      "  choice: \"block/library_choice\"",
      "}",
      "template emit(",
      "  explicit: ModelId,",
      "  fallback: ModelId = \"block/default\",",
      "  payload: Bundle = exported",
      ") {",
      "  json \"assets/caller/from-template.json\" {",
      "    explicit explicit",
      "    fallback fallback",
      "    payload payload",
      "  }",
      "}",
      "export { emit, exported }"
    ].join("\n");

    const result = compileRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainSource) },
      { fileName: libraryFile, module: parseRsgl(librarySource) }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "assets/caller/direct.json").content, {
      direct: "caller:block/dynamic",
      imported: bundleJson("library")
    });
    assert.deepStrictEqual(unitByPath(result, "assets/caller/from-template.json").content, {
      explicit: "caller:block/dynamic",
      fallback: "library:block/default",
      payload: bundleJson("library")
    });

    const template = unitByPath(result, "assets/caller/from-template.json");
    assertObservationSource(template, "/explicit", mainFile, mainSource, "`block/${suffix}`");
    assertObservationSource(template, "/fallback", libraryFile, librarySource, "\"block/default\"");
    assertObservationSource(template, "/payload/model", libraryFile, librarySource, "\"block/library_model\"");
    assertObservationSource(template, "/payload/textures/0", libraryFile, librarySource, "\"block/library_texture\"");
  });

  it("preserves typed IDs and per-path origins through imported collection mappers", () => {
    const root = path.resolve("collection origin 集成 with spaces");
    const mainFile = path.join(root, "入口 pack.rsgl");
    const libraryFile = path.join(root, "映射 helpers.rsgl");
    const mainSource = [
      "namespace caller",
      "import { wrap } from \"./映射 helpers.rsgl\"",
      "let originals: List<ModelId> = [\"block/one\", \"block/two\"]",
      "let extra: List<ModelId> = [\"block/three\"]",
      "let entries = concat(",
      "  map(originals, wrap),",
      "  flatMap(extra, value => [wrap(value), wrap(value)])",
      ")",
      "let spreadEntries = [...entries]",
      "json \"assets/caller/collection-origins.json\" {",
      "  entries spreadEntries",
      "}"
    ].join("\n");
    const librarySource = [
      "namespace library",
      "type Entry = { model: ModelId; fixed: String }",
      "let wrap: (ModelId) -> Entry = value => {",
      "  model: value,",
      "  fixed: \"library-fixed\",",
      "}",
      "export { wrap }"
    ].join("\n");

    const result = compileRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainSource) },
      { fileName: libraryFile, module: parseRsgl(librarySource) }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    expectNoDiagnostics(result);
    const unit = unitByPath(result, "assets/caller/collection-origins.json");
    assert.deepStrictEqual(unit.content, {
      entries: [
        { model: "caller:block/one", fixed: "library-fixed" },
        { model: "caller:block/two", fixed: "library-fixed" },
        { model: "caller:block/three", fixed: "library-fixed" },
        { model: "caller:block/three", fixed: "library-fixed" }
      ]
    });

    assertObservationSource(unit, "/entries/0/model", mainFile, mainSource, "\"block/one\"");
    assertObservationSource(unit, "/entries/1/model", mainFile, mainSource, "\"block/two\"");
    assertObservationSource(unit, "/entries/2/model", mainFile, mainSource, "\"block/three\"");
    assertObservationSource(unit, "/entries/3/model", mainFile, mainSource, "\"block/three\"");

    const fixedOrigin = unit.validation?.referenceOrigins?.find(origin =>
      origin.generatedPath === "/entries/0/fixed"
    );
    assert.strictEqual(fixedOrigin?.sourceFile, libraryFile);
    assert.strictEqual(
      librarySource.slice(fixedOrigin?.sourceRange.start, fixedOrigin?.sourceRange.end),
      "\"library-fixed\""
    );
  });

  it("rejects one invalid dynamic ID before resolution while emitting a valid neighbor", () => {
    const fileName = path.resolve("typed dynamic 空格", "main.rsgl");
    const source = [
      "namespace demo",
      "let suffix = \"Bad Value\"",
      "model block bad { parent model_id(`block/${suffix}`) }",
      "json \"assets/demo/good.json\" { value \"ok\" }"
    ].join("\n");
    let resolverCalls = 0;

    const result = compileSource(source.split("\n"), {
      fileName,
      externResourceExists: () => {
        resolverCalls += 1;
        return true;
      }
    });

    const invalid = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.invalidConstructedResourceId"
    );
    assert.strictEqual(invalid.length, 1);
    assert.strictEqual(invalid[0].fileName, fileName);
    assert.strictEqual(source.slice(invalid[0].range.start, invalid[0].range.end), "`block/${suffix}`");
    assert.strictEqual(result.diagnostics.length, 1);
    assert.strictEqual(resolverCalls, 0);
    assert.deepStrictEqual(unitByPath(result, "assets/demo/good.json").content, { value: "ok" });
    assert.ok(!result.units.some(unit => unit.outputPath.endsWith("models/block/bad.json")));
  });

  it("discards complete resources when a direct evaluation seam fails", () => {
    const source = [
      "namespace demo",
      "let suffix = \"Bad Value\"",
      "blockstate variants bad_state {",
      "  { facing: north }: minecraft:builtin/generated",
      "  { facing: south }: model_id(`block/${suffix}`)",
      "}",
      "model block bad_model impl model_id(\"block/base\")(all: model_id(\"block/wrong\")) {}",
      "json \"assets/demo/good.json\" { value \"ok\" }"
    ];
    let resolverCalls = 0;

    const result = compileSource(source, {
      externResourceExists: () => {
        resolverCalls += 1;
        return true;
      }
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.resourceIdKindMismatch",
      "rsgl.invalidConstructedResourceId"
    ]);
    assert.strictEqual(resolverCalls, 0);
    assert.deepStrictEqual(unitByPath(result, "assets/demo/good.json").content, { value: "ok" });
    assert.ok(!result.units.some(unit => unit.outputPath.endsWith("blockstates/bad_state.json")));
    assert.ok(!result.units.some(unit => unit.outputPath.endsWith("models/block/bad_model.json")));
  });

  it("deduplicates runtime kind mismatches and keeps TextureVariable out of extern resolution", () => {
    const source = [
      "namespace demo",
      "extern! custom texture demo:block/stone",
      "item bad_item { model texture_id(\"item/wrong\") }",
      "blockstate variants bad_state { {}: resource_id(\"block/wrong\") }",
      "model block bad_texture { textures { all: model_id(\"block/wrong\") } }",
      "model block variable { textures { side: demo:block/stone, all: \"#side\" } }"
    ];
    let resolverCalls = 0;

    const result = compileSource(source, {
      externResourceExists: () => {
        resolverCalls += 1;
        return true;
      }
    });

    const mismatches = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.resourceIdKindMismatch"
    );
    assert.strictEqual(mismatches.length, 3);
    assert.deepStrictEqual(mismatches.map(diagnostic => diagnostic.message), [
      "TextureId cannot be used where ModelId is required.",
      "ResourceId cannot be used where ModelId is required.",
      "ModelId cannot be used where TextureId is required."
    ]);
    assert.strictEqual(result.diagnostics.length, 3);
    assert.strictEqual(resolverCalls, 0);
    assert.deepStrictEqual(
      (unitByPath(result, "assets/demo/models/block/variable.json").content as { textures: JsonValue }).textures,
      { side: "demo:block/stone", all: "#side" }
    );
    assert.deepStrictEqual(
      result.units.filter(unit => unit.external).map(unit => unit.external?.id),
      ["demo:block/stone"]
    );
  });

  it("reports one caller-site diagnostic for an imported template's wrong ID kind", () => {
    const root = path.resolve("typed template 错误 with spaces");
    const mainFile = path.join(root, "main.rsgl");
    const libraryFile = path.join(root, "库.rsgl");
    const mainSource = [
      "namespace caller",
      "import { emit } from \"./库.rsgl\"",
      "use emit(texture_id(\"block/wrong\"))"
    ].join("\n");
    const result = compileRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainSource) },
      {
        fileName: libraryFile,
        module: parseRsgl([
          "namespace library",
          "template emit(model: ModelId) { model block output { parent model } }",
          "export { emit }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => [
      diagnostic.code,
      diagnostic.fileName,
      mainSource.slice(diagnostic.range.start, diagnostic.range.end)
    ]), [[
      "rsgl.resourceIdKindMismatch",
      mainFile,
      "texture_id(\"block/wrong\")"
    ]]);
  });

  it("propagates an imported template default failure to the caller resource transaction", () => {
    const root = path.resolve("typed default 事务 with spaces");
    const mainFile = path.join(root, "main.rsgl");
    const libraryFile = path.join(root, "默认 库.rsgl");
    const mainSource = [
      "namespace caller",
      "import { emit } from \"./默认 库.rsgl\"",
      "model block bad { use emit() }",
      "json \"assets/caller/good.json\" { value \"ok\" }"
    ].join("\n");
    const librarySource = [
      "namespace library",
      "let suffix = \"Bad Value\"",
      "template emit(parent: ModelId = `block/${suffix}`) -> model { parent parent }",
      "export { emit }"
    ].join("\n");
    let resolverCalls = 0;

    const result = compileRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainSource) },
      { fileName: libraryFile, module: parseRsgl(librarySource) }
    ], {
      entryFileName: mainFile,
      externResourceExists: () => {
        resolverCalls += 1;
        return true;
      }
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => [
      diagnostic.code,
      diagnostic.fileName,
      librarySource.slice(diagnostic.range.start, diagnostic.range.end)
    ]), [[
      "rsgl.invalidConstructedResourceId",
      libraryFile,
      "`block/${suffix}`"
    ]]);
    assert.strictEqual(resolverCalls, 0);
    assert.deepStrictEqual(unitByPath(result, "assets/caller/good.json").content, { value: "ok" });
    assert.ok(!result.units.some(unit => unit.outputPath.endsWith("models/block/bad.json")));
  });
});

function bundleJson(namespace: string): Record<string, JsonValue> {
  return {
    model: `${namespace}:block/library_model`,
    optional: `${namespace}:block/library_optional`,
    textures: [`${namespace}:block/library_texture`],
    choice: `${namespace}:block/library_choice`
  };
}

function assertObservationSource(
  unit: ResourceUnit,
  generatedPath: string,
  sourceFile: string,
  source: string,
  expectedText: string
): void {
  const observation = unit.validation?.resourceValueObservations?.find(item =>
    item.generatedPath === generatedPath
  );
  assert.ok(observation, `Missing resource observation for ${generatedPath}`);
  assert.strictEqual(observation.sourceFile, sourceFile);
  assert.strictEqual(source.slice(observation.range.start, observation.range.end), expectedText);
}
