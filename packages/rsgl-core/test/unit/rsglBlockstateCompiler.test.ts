import * as assert from "node:assert";
import * as path from "node:path";
import { compileRsglFile, compileRsglProgram } from "../../src/compiler";
import { RsglCompiler } from "../../src/compiler/compiler";
import { parseRsgl } from "../../src/parser";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  withUncheckedExterns
} from "./helpers/compile";

describe("RSGL canonical blockstate compiler", () => {
  it("evaluates selector, model, option, and predicate expressions once", () => {
    const module = parseRsgl([
      "blockstate variants once {",
      "  case (glob(\"selector\")[0] ? { slot: selected } : { slot: fallback }) =>",
      "    glob(\"head\")[0] with { uvlock: glob(\"option\")[0] ? true : false }",
      "}",
      "blockstate multipart once_multipart {",
      "  part when $state[glob(\"predicate\")[0]] == true => minecraft:block/stone",
      "}"
    ].join("\n"));
    const calls: string[] = [];
    const values: Record<string, string[]> = {
      selector: ["enabled"],
      head: ["minecraft:block/stone"],
      option: ["enabled"],
      predicate: ["north"]
    };

    const result = new RsglCompiler(module, {
      fileName: "once.rsgl",
      namespace: "minecraft",
      stdlibTemplates: [],
      globLoader: pattern => {
        calls.push(pattern);
        return values[pattern] ?? [];
      }
    }).compile();

    assert.deepStrictEqual(module.diagnostics, []);
    assert.deepStrictEqual(result.diagnostics, []);
    assert.deepStrictEqual(calls, ["selector", "head", "option", "predicate"]);
    assert.deepStrictEqual(result.units.map(unit => unit.content), [
      {
        variants: {
          "slot=selected": { model: "minecraft:block/stone", uvlock: true }
        }
      },
      {
        multipart: [{
          apply: { model: "minecraft:block/stone" },
          when: { north: "true" }
        }]
      }
    ]);
  });

  it("omits canonical ModelSpec and option defaults", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate variants defaults {",
      "  case { kind: single } => minecraft:block/single with {",
      "    x: 0, y: 0, z: 0, uvlock: false",
      "  }",
      "  case { kind: random } => random {",
      "    option minecraft:block/a with { x: 0, uvlock: false } weight 1",
      "    option minecraft:block/b with { y: 0 }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        "kind=random": [
          { model: "minecraft:block/a" },
          { model: "minecraft:block/b" }
        ],
        "kind=single": { model: "minecraft:block/single" }
      }
    });
  });

  it("keeps random and conditional lets lexically scoped", () => {
    const result = compileSourceWithUncheckedExterns([
      "let selected: ModelId = minecraft:block/root",
      "blockstate variants scoped_lets {",
      "  case { kind: random } => random {",
      "    let selected: ModelId = minecraft:block/random",
      "    option selected",
      "    if true {",
      "      let selected: ModelId = minecraft:block/branch",
      "      option selected",
      "    }",
      "    option selected",
      "  }",
      "  if true {",
      "    let selected: ModelId = minecraft:block/conditional",
      "    case { kind: conditional } => selected",
      "  }",
      "  case { kind: root } => selected",
      "}",
      "let attached: StatePredicate = $state.north == true",
      "blockstate multipart scoped_predicate {",
      "  part when attached => random {",
      "    let attached: StatePredicate = $state.south == true",
      "    option minecraft:block/side",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        "kind=conditional": { model: "minecraft:block/conditional" },
        "kind=random": [
          { model: "minecraft:block/random" },
          { model: "minecraft:block/branch" },
          { model: "minecraft:block/random" }
        ],
        "kind=root": { model: "minecraft:block/root" }
      }
    });
    assert.deepStrictEqual(result.units[1].content, {
      multipart: [{
        apply: [{ model: "minecraft:block/side" }],
        when: { north: "true" }
      }]
    });
  });

  it("isolates blockstate resource and top-level block bindings", () => {
    const result = compileSourceWithUncheckedExterns([
      "let selected: ModelId = minecraft:block/root",
      "blockstate variants first_resource {",
      "  let selected: ModelId = minecraft:block/resource",
      "  case * => selected",
      "}",
      "if true {",
      "  let selected: ModelId = minecraft:block/block",
      "  blockstate variants nested_resource { case * => selected }",
      "}",
      "blockstate variants final_resource { case * => selected }"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      result.units.filter(unit => unit.kind === "blockstate").map(unit => unit.content),
      [
        { variants: { "": { model: "minecraft:block/resource" } } },
        { variants: { "": { model: "minecraft:block/block" } } },
        { variants: { "": { model: "minecraft:block/root" } } }
      ]
    );
  });

  it("rejects invalid ModelSpec fields without accepting object or list facts", () => {
    const result = compileSourceWithUncheckedExterns([
      "let options = { x: 90 }",
      "let field = \"x\"",
      "blockstate variants invalid_specs {",
      "  case { kind: unknown } => minecraft:block/a with { future_field: true }",
      "  case { kind: spread } => minecraft:block/b with { ...options }",
      "  case { kind: computed } => minecraft:block/c with { [field]: 90 }",
      "  case { kind: weight } => minecraft:block/d with { weight: 2 }",
      "  case { kind: rotation } => minecraft:block/e with { x: 45 }",
      "  case { kind: uvlock } => minecraft:block/f with { uvlock: \"yes\" }",
      "}"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    for (const expected of [
      "rsgl.unknownBlockstateModelField",
      "rsgl.invalidBlockstateModelOptionsSpread",
      "rsgl.invalidBlockstateModelOption",
      "rsgl.blockstateWeightInvalidContext",
      "rsgl.invalidBlockstateRotation"
    ]) {
      assert.ok(codes.includes(expected), `Missing ${expected}`);
    }
    assert.ok(
      codes.includes("rsgl.typeMismatch") || codes.includes("rsgl.invalidBlockstateUvlock"),
      "Expected an invalid uvlock diagnostic."
    );
    assert.deepStrictEqual(result.units[0].content, { variants: {} });
  });

  it("retains computed selector failures through multi-dimensional loop bindings", () => {
    const source = [
      "blockstate variants loop_issue {",
      "  for ignored in [true], selector in [{ [[][0]]: true }] {",
      "    case selector => minecraft:block/stone",
      "  }",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));
    const diagnostic = result.diagnostics.find(item =>
      item.code === "rsgl.invalidBlockstateSelectorKey"
    );

    assert.ok(diagnostic);
    assert.strictEqual(source.slice(diagnostic.range.start, diagnostic.range.end), "[[][0]]");
    assert.deepStrictEqual(result.units, []);
  });

  it("rejects duplicate runtime selector keys after canonical evaluation", () => {
    const source = [
      "let first = \"facing\"",
      "let second = \"facing\"",
      "blockstate variants duplicate_selector {",
      "  case { [first]: north, [second]: south } => minecraft:block/stone",
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

  it("rejects data-driven empty selectors in favor of case wildcard", () => {
    const result = compileSourceWithUncheckedExterns([
      "let empty = {}",
      "blockstate variants empty_data_selector {",
      "  case empty => minecraft:block/stone",
      "}"
    ]);

    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.emptyBlockstateSelectorUseWildcard"
    ));
    assert.deepStrictEqual(result.units[0]?.content, { variants: {} });
  });

  it("lowers let, member, and call selector expressions without parentheses", () => {
    const result = compileSourceWithUncheckedExterns([
      "let row = { state: { slot: \"member\" } }",
      "let identity = (value) => value",
      "blockstate variants expression_selectors {",
      "  case row.state => minecraft:block/member",
      "  case identity({ slot: \"call\" }) => minecraft:block/call",
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

  it("keeps multipart part, merge, template, and root loop outputs in execution order", () => {
    const result = compileSourceWithUncheckedExterns([
      "template middle() -> multipart {",
      "  part always => minecraft:block/third",
      "}",
      "blockstate multipart ordered {",
      "  part always => minecraft:block/first",
      "  merge append {",
      "    multipart: [{ apply: { model: minecraft:block/second } }]",
      "  }",
      "  use middle()",
      "  for modelId in [minecraft:block/fourth, minecraft:block/fifth] {",
      "    part always => modelId",
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
      modelMappings.map(mapping => mapping.reason),
      ["direct", "direct", "template", "loop", "loop"]
    );
  });

  it("maps the mode header, selector, ModelSpec fields, and random options independently", () => {
    const source = [
      "blockstate variants mapped {",
      "  case { facing: north } => minecraft:block/single with { x: 90 }",
      "  case { facing: south } => random {",
      "    option minecraft:block/a weight 2",
      "    option minecraft:block/b",
      "  }",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));

    expectNoDiagnostics(result);
    const mappings = result.units[0].sourceMap.mappings;
    const rangeForPath = (generatedPath: string) => mappings.find(mapping =>
      mapping.generatedPath === generatedPath
    )?.sourceRange;

    assert.deepStrictEqual(rangeForPath("/variants"), textRange(source, "variants"));
    assert.deepStrictEqual(
      rangeForPath("/variants/facing=north"),
      textRange(source, "{ facing: north }")
    );
    assert.deepStrictEqual(
      rangeForPath("/variants/facing=north/model"),
      textRange(source, "minecraft:block/single")
    );
    assert.deepStrictEqual(rangeForPath("/variants/facing=north/x"), textRange(source, "90"));
    assert.deepStrictEqual(
      rangeForPath("/variants/facing=south/0/model"),
      textRange(source, "minecraft:block/a")
    );
    assert.deepStrictEqual(rangeForPath("/variants/facing=south/0/weight"), textRange(source, "2"));
    assert.deepStrictEqual(
      rangeForPath("/variants/facing=south/1/model"),
      textRange(source, "minecraft:block/b")
    );
  });

  it("retains origins through ModelId lets, with fields, and random options", () => {
    const source = [
      "let top: ModelId = minecraft:block/top",
      "let topX = 90",
      "blockstate variants traced_values {",
      "  let local: ModelId = minecraft:block/local",
      "  let localUvlock = true",
      "  let randomA: ModelId = minecraft:block/random_a",
      "  let randomB: ModelId = minecraft:block/random_b",
      "  case { slot: \"top\" } => top with { x: topX }",
      "  case { slot: \"local\" } => local with { uvlock: localUvlock }",
      "  case { slot: \"random\" } => random {",
      "    option randomA weight 2",
      "    option randomB with { y: 90 }",
      "  }",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));

    expectNoDiagnostics(result);
    const origins = result.units[0].validation?.referenceOrigins ?? [];
    const sourceTextForOrigin = (generatedPath: string) => {
      const origin = origins.find(item => item.generatedPath === generatedPath);
      assert.ok(origin, `Missing validation origin for ${generatedPath}`);
      return source.slice(origin.sourceRange.start, origin.sourceRange.end);
    };
    assert.strictEqual(sourceTextForOrigin("/variants/slot=top/model"), "minecraft:block/top");
    assert.strictEqual(sourceTextForOrigin("/variants/slot=local/model"), "minecraft:block/local");
    assert.strictEqual(sourceTextForOrigin("/variants/slot=random/0/model"), "minecraft:block/random_a");
    assert.strictEqual(sourceTextForOrigin("/variants/slot=random/1/model"), "minecraft:block/random_b");
  });

  it("evaluates conditional loop inputs once and preserves ModelId member origins", () => {
    const source = [
      "blockstate variants traced_loop {",
      "  for entry in (glob(\"rows\")[0] ? [",
      "    { state: { slot: first }, model: minecraft:block/first },",
      "    { state: { slot: second }, model: minecraft:block/second }",
      "  ] : []) {",
      "    case entry.state => entry.model",
      "  }",
      "}"
    ].join("\n");
    let globCalls = 0;
    const module = parseRsgl(source);
    const result = new RsglCompiler(module, {
      fileName: "loop-origin.rsgl",
      namespace: "minecraft",
      stdlibTemplates: [],
      globLoader: () => {
        globCalls += 1;
        return ["enabled"];
      }
    }).compile();

    assert.deepStrictEqual(module.diagnostics, []);
    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(globCalls, 1);
    const origins = result.units[0].validation?.referenceOrigins ?? [];
    for (const [slot, modelText] of [
      ["first", "minecraft:block/first"],
      ["second", "minecraft:block/second"]
    ]) {
      const origin = origins.find(item =>
        item.generatedPath === `/variants/slot=${slot}/model`
      );
      assert.ok(origin, `Missing ${slot} loop-item origin`);
      assert.strictEqual(source.slice(origin.sourceRange.start, origin.sourceRange.end), modelText);
    }
  });

  it("preserves named loop-field origins independently of object insertion order", () => {
    const source = [
      "blockstate variants named_loop_origin {",
      "  for { state, model: selectedModel } in [",
      "    { model: minecraft:block/first, state: { slot: first } },",
      "    { state: { slot: second }, model: minecraft:block/second }",
      "  ] {",
      "    case state => selectedModel",
      "  }",
      "}"
    ].join("\n");
    const module = parseRsgl(source);
    const result = new RsglCompiler(module, {
      fileName: "named-loop-origin.rsgl",
      namespace: "minecraft",
      stdlibTemplates: []
    }).compile();

    assert.deepStrictEqual(module.diagnostics, []);
    assert.deepStrictEqual(result.diagnostics, []);
    const origins = result.units[0].validation?.referenceOrigins ?? [];
    for (const [slot, modelText] of [
      ["first", "minecraft:block/first"],
      ["second", "minecraft:block/second"]
    ]) {
      const origin = origins.find(item =>
        item.generatedPath === `/variants/slot=${slot}/model`
      );
      assert.ok(origin, `Missing ${slot} named loop-field origin`);
      assert.strictEqual(source.slice(origin.sourceRange.start, origin.sourceRange.end), modelText);
    }
  });

  it("preserves imported ModelId origins through single and random choices", () => {
    const root = path.resolve("/virtual/rsgl-blockstate-origin");
    const mainFile = path.join(root, "main.rsgl");
    const valuesFile = path.join(root, "values.rsgl");
    const valuesSource = [
      "let importedModel: ModelId = minecraft:block/imported",
      "let importedRandomModel: ModelId = minecraft:block/imported_random",
      "export { importedModel, importedRandomModel }"
    ].join("\n");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { importedModel, importedRandomModel } from \"./values.rsgl\"",
          "blockstate variants imported_values {",
          "  case { slot: item } => importedModel with { x: 90 }",
          "  case { slot: random } => random { option importedRandomModel }",
          "}"
        ].join("\n"))
      },
      { fileName: valuesFile, module: parseRsgl(valuesSource) }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    expectNoDiagnostics(result);
    const unit = result.units.find(item => item.kind === "blockstate");
    assert.ok(unit);
    const origins = unit.validation?.referenceOrigins ?? [];
    for (const [generatedPath, sourceText] of [
      ["/variants/slot=item/model", "minecraft:block/imported"],
      ["/variants/slot=random/0/model", "minecraft:block/imported_random"]
    ]) {
      const origin = origins.find(item => item.generatedPath === generatedPath);
      assert.ok(origin, `Missing imported origin for ${generatedPath}`);
      assert.strictEqual(origin.sourceFile, valuesFile);
      assert.strictEqual(
        valuesSource.slice(origin.sourceRange.start, origin.sourceRange.end),
        sourceText
      );
    }
  });

  it("lowers typed StatePredicate operators to canonical Minecraft conditions", () => {
    const result = compileSourceWithUncheckedExterns([
      "let attached: StatePredicate = $state.north == true || $state.south == true",
      "let direction = \"west\"",
      "blockstate multipart predicates {",
      "  part when $state.facing in [north, south] && $state.power in 1..2 => minecraft:block/ranged",
      "  part when !attached => minecraft:block/detached",
      "  part when $state[direction] != false => minecraft:block/dynamic",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      multipart: [
        {
          apply: { model: "minecraft:block/ranged" },
          when: { facing: "north|south", power: "1|2" }
        },
        {
          apply: { model: "minecraft:block/detached" },
          when: { north: "!true", south: "!true" }
        },
        {
          apply: { model: "minecraft:block/dynamic" },
          when: { west: "!false" }
        }
      ]
    });
  });

  it("lowers boolean state-property shorthand without changing explicit negation", () => {
    const result = compileSourceWithUncheckedExterns([
      "let direction = \"west\"",
      "let direct: StatePredicate = $state.up",
      "blockstate multipart shorthand {",
      "  part when direct => minecraft:block/direct",
      "  part when !$state.down => minecraft:block/negated",
      "  part when $state[direction] && !$state.east => minecraft:block/combined",
      "  part when !($state.south == true) => minecraft:block/explicit_not",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      multipart: [
        {
          apply: { model: "minecraft:block/direct" },
          when: { up: "true" }
        },
        {
          apply: { model: "minecraft:block/negated" },
          when: { down: "false" }
        },
        {
          apply: { model: "minecraft:block/combined" },
          when: { east: "false", west: "true" }
        },
        {
          apply: { model: "minecraft:block/explicit_not" },
          when: { south: "!true" }
        }
      ]
    });
  });

  it("keeps root part expansion separate from random option expansion", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate multipart boundaries {",
      "  for direction in [\"north\", \"east\"] {",
      "    part when $state[direction] == true => minecraft:block/side with { y: yaw(direction) }",
      "  }",
      "  part always => random {",
      "    for idx in 0..1 {",
      "      option `minecraft:block/frame_${idx}` with { y: idx * 90 }",
      "    }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const multipart = (result.units[0].content as { multipart: unknown[] }).multipart;
    assert.strictEqual(multipart.length, 3, "root for must generate two independent parts plus one random part");
    assert.deepStrictEqual(multipart, [
      {
        apply: { model: "minecraft:block/side" },
        when: { north: "true" }
      },
      {
        apply: { model: "minecraft:block/side", y: 90 },
        when: { east: "true" }
      },
      {
        apply: [
          { model: "minecraft:block/frame_0" },
          { model: "minecraft:block/frame_1", y: 90 }
        ]
      }
    ]);
  });

  it("rejects every removed blockstate surface without emitting a resource", () => {
    const cases: Array<[string, string]> = [
      [
        "blockstate old { variants { [facing=north] -> @minecraft:block/old } }",
        "rsgl.blockstateModeRequired"
      ],
      [
        "blockstate variants old { [facing=north] -> minecraft:block/old }",
        "rsgl.expectedBlockstateCase"
      ],
      [
        "blockstate variants old { case * => @minecraft:block/old }",
        "rsgl.expectedExpression"
      ],
      [
        "blockstate variants old { {}: minecraft:block/old }",
        "rsgl.legacyBlockstateVariantEntry"
      ],
      [
        "blockstate multipart old { apply minecraft:block/old }",
        "rsgl.legacyBlockstateMultipartEntry"
      ],
      [
        "blockstate multipart old { when { north: true } apply minecraft:block/old }",
        "rsgl.legacyBlockstateMultipartEntry"
      ],
      [
        "blockstate variants old { case * => minecraft:block/old x=90 }",
        "rsgl.legacyBlockstateModelModifiers"
      ],
      [
        "blockstate variants old { case * => { model: minecraft:block/old } }",
        "rsgl.legacyBlockstateModelValue"
      ],
      [
        "blockstate variants old { case * => [minecraft:block/a, minecraft:block/b] }",
        "rsgl.legacyBlockstateModelValue"
      ],
      [
        "blockstate variants old { case * => random [minecraft:block/a] }",
        "rsgl.legacyBlockstateRandomList"
      ]
    ];

    for (const [source, expected] of cases) {
      const result = compileSourceWithUncheckedExterns([source]);
      assert.ok(
        result.diagnostics.some(diagnostic => diagnostic.code === expected),
        `Missing ${expected} for ${source}`
      );
      assert.deepStrictEqual(result.units, [], `Removed syntax must not emit a unit: ${source}`);
    }
  });

  it("rejects raw multipart condition objects instead of lowering legacy conditions", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate multipart raw_condition {",
      "  part when { north: true } => minecraft:block/old",
      "}"
    ]);

    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidBlockstatePredicate"
    ));
    assert.deepStrictEqual(result.units[0]?.content, { multipart: [] });
  });

  it("attributes canonical stdlib model references to caller extern scope", () => {
    const fixture = path.resolve(
      "packages/rsgl-core/test/fixtures/stdlib-blockstate-conventions.rsgl"
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

function textRange(source: string, text: string, occurrence = 0): { start: number; end: number } {
  let start = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    start = source.indexOf(text, start + 1);
  }
  assert.notStrictEqual(start, -1, `Missing source text: ${text}`);
  return { start, end: start + text.length };
}
