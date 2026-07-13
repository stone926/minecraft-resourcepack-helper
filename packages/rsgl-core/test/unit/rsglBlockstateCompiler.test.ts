import * as assert from "node:assert";
import * as path from "node:path";
import { compileRsglFile, compileRsglProgram } from "../../src/compiler";
import { RsglCompiler } from "../../src/compiler/compiler";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule } from "../../src/semantic";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  withUncheckedExterns
} from "./helpers/compile";

describe("RSGL canonical blockstate compiler", () => {
  it("evaluates selector, model head, property, and when expressions once", () => {
    const module = parseRsgl([
      "blockstate variants once {",
      "  (glob(\"selector\")[0] ? {} : {}):",
      "    glob(\"head\")[0] uvlock=(glob(\"property\")[0] ? true : false)",
      "}",
      "blockstate multipart once_multipart {",
      "  when (glob(\"when\")[0] ? { north: true } : {})",
      "    apply minecraft:block/stone",
      "}"
    ].join("\n"));
    const model = bindRsglModule(module);
    const calls: string[] = [];
    const values: Record<string, string[]> = {
      selector: ["selected"],
      head: ["minecraft:block/stone"],
      property: ["enabled"],
      when: ["enabled"]
    };

    const result = new RsglCompiler(module, {
      fileName: "once.rsgl",
      namespace: "minecraft",
      stdlibTemplates: [],
      blockstateApplyFacts: model.blockstateApplyFacts,
      globLoader: pattern => {
        calls.push(pattern);
        return values[pattern] ?? [];
      }
    }).compile();

    assert.deepStrictEqual(module.diagnostics, []);
    assert.deepStrictEqual(model.diagnostics, []);
    assert.deepStrictEqual(result.diagnostics, []);
    assert.deepStrictEqual(calls, ["selector", "head", "property", "when"]);
    assert.deepStrictEqual(result.units.map(unit => unit.content), [
      {
        variants: {
          "": { model: "minecraft:block/stone", uvlock: true }
        }
      },
      {
        multipart: [
          {
            apply: { model: "minecraft:block/stone" },
            when: { north: true }
          }
        ]
      }
    ]);
  });

  it("preserves defaults in complete objects/lists but omits shorthand defaults", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate variants defaults {",
      "  { kind: object }: {",
      "    model: minecraft:block/object, x: 0, y: 0, z: 0, uvlock: false, weight: 1",
      "  }",
      "  { kind: list }: [",
      "    { model: minecraft:block/a, x: 0, uvlock: false, weight: 1 },",
      "    { model: minecraft:block/b, y: 0 }",
      "  ]",
      "  { kind: shorthand }:",
      "    minecraft:block/short x=0 y=0 z=0 uvlock=false weight=1",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        "kind=list": [
          {
            model: "minecraft:block/a",
            x: 0,
            uvlock: false,
            weight: 1
          },
          { model: "minecraft:block/b", y: 0 }
        ],
        "kind=object": {
          model: "minecraft:block/object",
          x: 0,
          y: 0,
          z: 0,
          uvlock: false,
          weight: 1
        },
        "kind=shorthand": { model: "minecraft:block/short" }
      }
    });
  });

  it("preserves unknown model fields only for explicit Json facts", () => {
    const result = compileSourceWithUncheckedExterns([
      "let escaped: Json = { model: minecraft:block/escaped, future_field: true }",
      "let closed = { model: minecraft:block/closed, misspelled: true }",
      "blockstate variants facts {",
      "  { kind: keep }: escaped",
      "  { kind: reject }: closed",
      "}"
    ]);

    assert.strictEqual(
      result.diagnostics.filter(diagnostic =>
        diagnostic.code === "rsgl.unknownBlockstateModelField"
      ).length,
      1
    );
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        "kind=keep": {
          model: "minecraft:block/escaped",
          future_field: true
        }
      }
    });
  });

  it("rejects recursively unserializable blockstate Json values without normalizing them to null", () => {
    const source = [
      "let lambdaValue: Json = { model: minecraft:block/a, future: (x) => x }",
      "let undefinedValue: Json = { model: minecraft:block/b, future: {}.missing }",
      "let callValue: Json = { model: minecraft:block/c, future: unknown() }",
      "let nonFiniteValue: Json = { model: minecraft:block/d, future: 1 / 0 }",
      "blockstate variants invalid_json {",
      "  { slot: lambda }: lambdaValue",
      "  { slot: undefined }: undefinedValue",
      "  { slot: call }: callValue",
      "  { slot: number }: nonFiniteValue",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));
    const diagnostics = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.unserializableBlockstateJsonValue"
    );

    assert.strictEqual(diagnostics.length, 4);
    assert.deepStrictEqual(new Set(diagnostics.map(diagnostic =>
      source.slice(diagnostic.range.start, diagnostic.range.end)
    )), new Set(["(x) => x", "{}.missing", "unknown()", "1 / 0"]));
    assert.deepStrictEqual(result.units[0].content, { variants: {} });
  });

  it("retains value-shape issues through template argument binding", () => {
    const source = [
      "template emit(value: Json) -> variants { { slot: invalid }: value }",
      "blockstate variants template_json {",
      "  use emit({ model: minecraft:block/a, future: [][0] })",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));
    const diagnostic = result.diagnostics.find(item =>
      item.code === "rsgl.unserializableBlockstateJsonValue"
    );

    assert.ok(diagnostic);
    assert.strictEqual(source.slice(diagnostic.range.start, diagnostic.range.end), "[][0]");
    assert.deepStrictEqual(result.units[0].content, { variants: {} });
  });

  it("rejects lossy computed keys in explicit Json at the computed key", () => {
    const source = [
      "let first = \"future\"",
      "let second = \"future\"",
      "let missing = [][0]",
      "let duplicate: Json = { model: minecraft:block/a, [first]: true, [second]: false }",
      "let invalid: Json = { model: minecraft:block/b, [missing]: true }",
      "blockstate variants lossy_json {",
      "  { slot: \"duplicate\" }: duplicate",
      "  { slot: \"invalid\" }: invalid",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));
    const diagnostics = result.diagnostics.filter(item =>
      item.code === "rsgl.unserializableBlockstateJsonValue"
    );

    assert.strictEqual(diagnostics.length, 2);
    assert.deepStrictEqual(
      new Set(diagnostics.map(diagnostic => source.slice(diagnostic.range.start, diagnostic.range.end))),
      new Set(["[second]", "[missing]"])
    );
    assert.ok(diagnostics.some(diagnostic => diagnostic.message.includes("duplicate computed object key")));
    assert.ok(diagnostics.some(diagnostic => diagnostic.message.includes("computed object key without a value")));
    assert.deepStrictEqual(result.units[0].content, { variants: {} });
  });

  it("retains computed-key issues through multi-dimensional loop bindings", () => {
    const source = [
      "blockstate variants loop_issue {",
      "  for ignored in [true], selector in [{ [[][0]]: true }] {",
      "    (selector): minecraft:block/stone",
      "  }",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));
    const diagnostic = result.diagnostics.find(item =>
      item.code === "rsgl.invalidBlockstateSelectorKey"
    );

    assert.ok(diagnostic);
    assert.strictEqual(source.slice(diagnostic.range.start, diagnostic.range.end), "[[][0]]");
    assert.deepStrictEqual(result.units[0].content, { variants: {} });
  });

  it("rejects cyclic runtime values without recursing or leaking the object", () => {
    const source = "blockstate variants cyclic { {}: injected }";
    const module = parseRsgl(source);
    const model = bindRsglModule(module);
    const cyclic: Record<string, unknown> = { model: "minecraft:block/cyclic" };
    cyclic.future = cyclic;
    const result = new RsglCompiler(module, {
      fileName: "cyclic.rsgl",
      namespace: "minecraft",
      stdlibTemplates: [],
      blockstateApplyFacts: model.blockstateApplyFacts,
      externalValues: [{ name: "injected", value: cyclic as never }]
    }).compile();

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.unserializableBlockstateJsonValue"
    ]);
    assert.deepStrictEqual(result.units[0].content, { variants: {} });
  });

  it("attributes imported Json runtime field diagnostics to each definition field", () => {
    const root = path.resolve("/virtual/rsgl-blockstate-invalid-json");
    const mainFile = path.join(root, "main.rsgl");
    const barrelFile = path.join(root, "barrel.rsgl");
    const definitionsFile = path.join(root, "definitions.rsgl");
    const definitionsSource = [
      "let invalidJson: Json = { model: minecraft:block/a, future: unknown() }",
      "let invalidX: Json = { model: minecraft:block/b, x: 45 }",
      "let invalidUvlock: Json = { model: minecraft:block/c, uvlock: \"yes\" }",
      "let invalidWeight: Json = { model: minecraft:block/d, weight: 0 }",
      "export { invalidJson, invalidX, invalidUvlock, invalidWeight }"
    ].join("\n");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import \"./barrel.rsgl\"",
          "blockstate variants imported_invalid {",
          "  { slot: json }: invalidJson",
          "  { slot: x }: invalidX",
          "  { slot: uvlock }: invalidUvlock",
          "  { slot: weight }: invalidWeight",
          "}"
        ].join("\n"))
      },
      { fileName: barrelFile, module: parseRsgl("export * from \"./definitions.rsgl\"") },
      { fileName: definitionsFile, module: parseRsgl(definitionsSource) }
    ], withUncheckedExterns({ entryFileName: mainFile }));
    const expected = new Map([
      ["rsgl.unserializableBlockstateJsonValue", "unknown()"],
      ["rsgl.invalidBlockstateRotation", "45"],
      ["rsgl.invalidBlockstateUvlock", "\"yes\""],
      ["rsgl.invalidRandomWeight", "0"]
    ]);

    for (const [code, sourceText] of expected) {
      const diagnostic = result.diagnostics.find(item => item.code === code);
      assert.ok(diagnostic, `Missing ${code}`);
      assert.strictEqual(diagnostic.fileName, definitionsFile);
      assert.strictEqual(
        definitionsSource.slice(diagnostic.range.start, diagnostic.range.end),
        sourceText
      );
    }
  });

  it("retains captured template value issues and field origins across files", () => {
    const root = path.resolve("/virtual/rsgl-blockstate-template-capture");
    const mainFile = path.join(root, "main.rsgl");
    const definitionsFile = path.join(root, "definitions.rsgl");
    const definitionsSource = [
      "let capturedJson: Json = { model: minecraft:block/a, future: unknown() }",
      "let capturedRotation: Json = { model: minecraft:block/b, x: 45 }",
      "template emit() -> variants {",
      "  { slot: json }: capturedJson",
      "  { slot: rotation }: capturedRotation",
      "}",
      "export { emit }"
    ].join("\n");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { emit } from \"./definitions.rsgl\"",
          "blockstate variants captured { use emit() }"
        ].join("\n"))
      },
      { fileName: definitionsFile, module: parseRsgl(definitionsSource) }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    for (const [code, text] of [
      ["rsgl.unserializableBlockstateJsonValue", "unknown()"],
      ["rsgl.invalidBlockstateRotation", "45"]
    ] as const) {
      const diagnostic = result.diagnostics.find(item => item.code === code);
      assert.ok(diagnostic, `Missing ${code}`);
      assert.strictEqual(diagnostic.fileName, definitionsFile);
      assert.strictEqual(
        definitionsSource.slice(diagnostic.range.start, diagnostic.range.end),
        text
      );
    }
  });

  it("rejects duplicate runtime selector keys after canonical evaluation", () => {
    const source = [
      "let first = \"facing\"",
      "let second = \"facing\"",
      "blockstate variants duplicate_selector {",
      "  { [first]: north, [second]: south }: minecraft:block/stone",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));
    const diagnostic = result.diagnostics.find(item =>
      item.code === "rsgl.duplicateBlockstateSelectorProperty"
    );

    assert.ok(diagnostic);
    assert.strictEqual(source.slice(diagnostic.range.start, diagnostic.range.end), "[second]");
    assert.deepStrictEqual(result.units[0].content, { variants: {} });
  });

  it("lowers parenthesized let, member, and call selectors", () => {
    const result = compileSourceWithUncheckedExterns([
      "let row = { state: { slot: \"member\" } }",
      "let identity = (value) => value",
      "blockstate variants expression_selectors {",
      "  (row.state): minecraft:block/member",
      "  (identity({ slot: \"call\" })): minecraft:block/call",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        "slot=call": { model: "minecraft:block/call" },
        "slot=member": { model: "minecraft:block/member" }
      }
    });
  });

  it("keeps multipart entry, merge, template, and loop outputs in execution order", () => {
    const result = compileSourceWithUncheckedExterns([
      "template middle() -> multipart {",
      "  apply minecraft:block/third",
      "}",
      "blockstate multipart ordered {",
      "  apply minecraft:block/first",
      "  merge append {",
      "    multipart: [{ apply: { model: minecraft:block/second } }]",
      "  }",
      "  use middle()",
      "  for modelId in [minecraft:block/fourth, minecraft:block/fifth] {",
      "    apply modelId",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      multipart: [
        { apply: { model: "minecraft:block/first" } },
        { apply: { model: "minecraft:block/second" } },
        { apply: { model: "minecraft:block/third" } },
        { apply: { model: "minecraft:block/fourth" } },
        { apply: { model: "minecraft:block/fifth" } }
      ]
    });
    const modelMappings = result.units[0].sourceMap.mappings.filter(mapping =>
      /^\/multipart\/\d+\/apply\/model$/.test(mapping.generatedPath)
    );
    assert.deepStrictEqual(
      modelMappings.map(mapping => mapping.generatedPath),
      [
        "/multipart/0/apply/model",
        "/multipart/1/apply/model",
        "/multipart/2/apply/model",
        "/multipart/3/apply/model",
        "/multipart/4/apply/model"
      ]
    );
    assert.deepStrictEqual(
      modelMappings.map(mapping => mapping.reason),
      ["direct", "direct", "template", "loop", "loop"]
    );
  });

  it("maps the mode header, selector, model, properties, and random items independently", () => {
    const source = [
      "blockstate variants mapped {",
      "  { facing: north }: minecraft:block/single x=90",
      "  { facing: south }: random [",
      "    minecraft:block/a weight=2,",
      "    minecraft:block/b",
      "  ]",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));

    expectNoDiagnostics(result);
    const mappings = result.units[0].sourceMap.mappings;
    const rangeOf = (text: string, occurrence = 0) => {
      let start = -1;
      for (let index = 0; index <= occurrence; index += 1) {
        start = source.indexOf(text, start + 1);
      }
      assert.notStrictEqual(start, -1, `Missing source text: ${text}`);
      return { start, end: start + text.length };
    };
    const rangeForPath = (generatedPath: string) => mappings.find(mapping =>
      mapping.generatedPath === generatedPath
    )?.sourceRange;

    assert.deepStrictEqual(rangeForPath("/variants"), rangeOf("variants"));
    assert.deepStrictEqual(rangeForPath("/variants/facing=north"), rangeOf("{ facing: north }"));
    assert.deepStrictEqual(
      rangeForPath("/variants/facing=north/model"),
      rangeOf("minecraft:block/single")
    );
    assert.deepStrictEqual(rangeForPath("/variants/facing=north/x"), rangeOf("90"));
    assert.deepStrictEqual(
      rangeForPath("/variants/facing=south/0/model"),
      rangeOf("minecraft:block/a")
    );
    assert.deepStrictEqual(rangeForPath("/variants/facing=south/0/weight"), rangeOf("2"));
    assert.deepStrictEqual(
      rangeForPath("/variants/facing=south/1/model"),
      rangeOf("minecraft:block/b")
    );
  });

  it("retains path origins through top-level/local let, member, and complete lists", () => {
    const source = [
      "let top = { model: minecraft:block/top, x: 90 }",
      "blockstate variants traced_values {",
      "  let local = {",
      "    item: { model: minecraft:block/local, uvlock: true },",
      "    choices: [",
      "      { model: minecraft:block/list_a, weight: 2 },",
      "      { model: minecraft:block/list_b, y: 90 }",
      "    ]",
      "  }",
      "  { slot: \"top\" }: top",
      "  { slot: \"local\" }: local.item",
      "  { slot: \"list\" }: local.choices",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));

    expectNoDiagnostics(result);
    const unit = result.units[0];
    const origins = unit.validation?.referenceOrigins ?? [];
    const sourceTextForOrigin = (generatedPath: string) => {
      const origin = origins.find(item => item.generatedPath === generatedPath);
      assert.ok(origin, `Missing validation origin for ${generatedPath}`);
      return source.slice(origin.sourceRange.start, origin.sourceRange.end);
    };
    assert.strictEqual(
      sourceTextForOrigin("/variants/slot=top/model"),
      "minecraft:block/top"
    );
    assert.strictEqual(
      sourceTextForOrigin("/variants/slot=local/model"),
      "minecraft:block/local"
    );
    assert.strictEqual(
      sourceTextForOrigin("/variants/slot=list/0/model"),
      "minecraft:block/list_a"
    );
    assert.strictEqual(
      sourceTextForOrigin("/variants/slot=list/1/y"),
      "90"
    );
  });

  it("evaluates conditional loop inputs once and preserves each item member origin", () => {
    const source = [
      "blockstate variants traced_loop {",
      "  for entry in (glob(\"rows\")[0] ? [",
      "    { state: { slot: first }, apply: { model: minecraft:block/first } },",
      "    { state: { slot: second }, apply: { model: minecraft:block/second } }",
      "  ] : []) {",
      "    (entry.state): entry.apply",
      "  }",
      "}"
    ].join("\n");
    let globCalls = 0;
    const module = parseRsgl(source);
    const model = bindRsglModule(module);
    const result = new RsglCompiler(module, {
      fileName: "loop-origin.rsgl",
      namespace: "minecraft",
      stdlibTemplates: [],
      blockstateApplyFacts: model.blockstateApplyFacts,
      globLoader: () => {
        globCalls += 1;
        return ["enabled"];
      }
    }).compile();

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(globCalls, 1);
    const origins = result.units[0].validation?.referenceOrigins ?? [];
    for (const [slot, modelText] of [["first", "minecraft:block/first"], ["second", "minecraft:block/second"]]) {
      const origin = origins.find(item =>
        item.generatedPath === `/variants/slot=${slot}/model`
      );
      assert.ok(origin, `Missing ${slot} loop-item origin`);
      assert.strictEqual(source.slice(origin.sourceRange.start, origin.sourceRange.end), modelText);
    }
  });

  it("preserves imported structured let origins through member and list access", () => {
    const root = path.resolve("/virtual/rsgl-blockstate-origin");
    const mainFile = path.join(root, "main.rsgl");
    const valuesFile = path.join(root, "values.rsgl");
    const valuesSource = [
      "let imported = {",
      "  item: { model: minecraft:block/imported, x: 90 },",
      "  choices: [{ model: minecraft:block/imported_list, uvlock: true }]",
      "}"
    ].join("\n");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { imported } from \"./values.rsgl\"",
          "blockstate variants imported_values {",
          "  { slot: item }: imported.item",
          "  { slot: list }: imported.choices",
          "}"
        ].join("\n"))
      },
      { fileName: valuesFile, module: parseRsgl(valuesSource) }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    expectNoDiagnostics(result);
    const unit = result.units.find(item => item.kind === "blockstate");
    assert.ok(unit);
    const origins = unit.validation?.referenceOrigins ?? [];
    const modelOrigin = origins.find(item =>
      item.generatedPath === "/variants/slot=item/model"
    );
    const listOrigin = origins.find(item =>
      item.generatedPath === "/variants/slot=list/0/model"
    );
    assert.ok(modelOrigin);
    assert.ok(listOrigin);
    assert.strictEqual(modelOrigin.sourceFile, valuesFile);
    assert.strictEqual(listOrigin.sourceFile, valuesFile);
    assert.strictEqual(
      valuesSource.slice(modelOrigin.sourceRange.start, modelOrigin.sourceRange.end),
      "minecraft:block/imported"
    );
    assert.strictEqual(
      valuesSource.slice(listOrigin.sourceRange.start, listOrigin.sourceRange.end),
      "minecraft:block/imported_list"
    );
  });

  it("attributes canonical stdlib model references to caller extern scope", () => {
    const fixture = path.resolve(
      "packages/rsgl-core/test/fixtures/abstraction-migration/canonical/stdlib-blockstate-conventions.rsgl"
    );
    const result = compileRsglFile(fixture);

    assert.deepStrictEqual(
      result.diagnostics.filter(item => item.code === "rsgl.undeclaredExternalResource"),
      []
    );
    const stateSequence = result.units.find(unit =>
      unit.outputPath.endsWith("blockstates/abstraction/stdlib_state_sequence.json")
    );
    assert.ok(stateSequence);
    const modelOrigins = stateSequence.validation?.referenceOrigins?.filter(origin =>
      /^\/variants\/age=\d+\/model$/.test(origin.generatedPath)
    ) ?? [];
    assert.strictEqual(modelOrigins.length, 3);
    assert.ok(modelOrigins.every(origin => path.normalize(origin.sourceFile) === path.normalize(fixture)));
  });
});
