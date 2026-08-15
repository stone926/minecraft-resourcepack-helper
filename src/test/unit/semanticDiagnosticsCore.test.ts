import * as assert from "node:assert/strict";
import * as path from "node:path";
import { uniqueValues } from "../../../packages/mc-assets/src";
import {
  getSemanticDiagnostics,
  isSemanticDiagnosticsDocument,
  semanticDiagnosticsHandlerKinds,
  type SemanticDiagnosticsDocument,
  type SemanticDiagnosticsHost,
  type SemanticDiagnosticsOptions
} from "../../diagnostics/semanticDiagnosticsCore";
import { buildSoundEventFileGraph } from "../../diagnostics/soundEventGraph";
import { lm } from "../../i18n/messages";
import { resourceSurfaceRegistry } from "../../resources/resourceSurfaceRegistry";
import { parseJsonAst } from "../../utils/jsonAst";

describe("semantic diagnostics core", () => {
  it("keeps registry routes and diagnostic handlers in sync", () => {
    const declaredKinds = uniqueValues(resourceSurfaceRegistry.flatMap(surface =>
      surface.semanticDiagnostics ? [surface.semanticDiagnostics] : []
    )).sort();

    assert.deepStrictEqual([...semanticDiagnosticsHandlerKinds].sort(), declaredKinds);
  });

  it("ignores documents outside the semantic diagnostic domains without reading them", async () => {
    const document: SemanticDiagnosticsDocument = {
      languageId: "json",
      fileName: path.join("pack", "data", "recipe.json"),
      getText: () => {
        throw new Error("Unrelated JSON should not be parsed");
      }
    };

    assert.strictEqual(isSemanticDiagnosticsDocument(document), false);
    assert.deepStrictEqual(await getSemanticDiagnostics(document, createOptions(createThrowingHost())), []);
  });

  it("preserves the JSON language gate for matching resource paths", async () => {
    const document: SemanticDiagnosticsDocument = {
      languageId: "plaintext",
      fileName: path.join("pack", "assets", "minecraft", "models", "block", "stone.json"),
      getText: () => {
        throw new Error("A matching path with the wrong language must not be parsed");
      }
    };

    assert.strictEqual(isSemanticDiagnosticsDocument(document), false);
    assert.deepStrictEqual(await getSemanticDiagnostics(document, createOptions(createThrowingHost())), []);
  });

  it("diagnoses atlas namespaces and names without dropping invalid files from tooling", async () => {
    const invalidDocument = createJsonDocument(
      path.join("pack", "assets", "custom", "atlases", "made_up.json"),
      { sources: [] }
    );
    const validDocument = createJsonDocument(
      path.join("pack", "assets", "minecraft", "atlases", "blocks.json"),
      { sources: [] }
    );

    const invalidDiagnostics = await getSemanticDiagnostics(invalidDocument, createOptions());
    const validDiagnostics = await getSemanticDiagnostics(validDocument, createOptions());

    assert.deepStrictEqual(
      invalidDiagnostics.map(diagnostic => [diagnostic.message.message, diagnostic.message.args]),
      [
        ["Atlas definitions are only loaded from the minecraft namespace.", undefined],
        ["Atlas '{0}' is not a built-in atlas registered by Minecraft 26.2.", ["made_up"]]
      ]
    );
    assert.deepStrictEqual(validDiagnostics, []);
  });

  it("flags pack.mcmeta files that use min_format without max_format and localizes pack image issues", async () => {
    const document = createJsonDocument(path.join("pack", "pack.mcmeta"), {
      pack: {
        ["min_format"]: [88, 0],
        description: "test"
      }
    });

    const diagnostics = await getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.map(diagnostic => [diagnostic.severity, diagnostic.message.message]),
      [
        ["warning", "pack.mcmeta must use min_format and max_format together for 1.21.9+ resource pack formats."],
        ["information", "{0}: {1}"]
      ]
    );
    assert.strictEqual(diagnostics[1].message.args?.[0], "pack.png");
    assert.ok(diagnostics.every(diagnostic =>
      diagnostic.range.start.line >= 0 &&
      diagnostic.range.start.character >= 0 &&
      (diagnostic.range.end.line > diagnostic.range.start.line ||
        diagnostic.range.end.character >= diagnostic.range.start.character)
    ));
  });

  it("allows redundant pack_format but rejects supported_formats for modern-only packs", async () => {
    const document = createJsonDocument(path.join("pack", "pack.mcmeta"), {
      pack: {
        ["min_format"]: [88, 0],
        ["max_format"]: [88, 0],
        ["pack_format"]: 88,
        ["supported_formats"]: [88, 88],
        description: "test"
      }
    });

    const diagnostics = await getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.filter(diagnostic => diagnostic.severity === "warning").map(diagnostic => diagnostic.message.message),
      ["Resource packs that only support 1.21.9+ must not use supported_formats."]
    );
  });

  it("reports missing modern format bounds without rejecting redundant pack_format", async () => {
    const document = createJsonDocument(path.join("pack", "pack.mcmeta"), {
      pack: {
        ["pack_format"]: 88,
        description: "test"
      }
    });

    const diagnostics = await getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.filter(diagnostic => diagnostic.severity === "warning").map(diagnostic => diagnostic.message.message),
      ["pack.mcmeta must use min_format and max_format together for 1.21.9+ resource pack formats."]
    );
  });

  it("validates legacy pack metadata fields against the complete declared range", async () => {
    const document = createJsonDocument(path.join("pack", "pack.mcmeta"), {
      pack: {
        ["min_format"]: 34,
        ["max_format"]: 88,
        ["pack_format"]: 34,
        ["supported_formats"]: [35, 88],
        description: "test"
      }
    });

    const diagnostics = await getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.filter(diagnostic => diagnostic.severity === "warning").map(diagnostic => diagnostic.message.message),
      [
        "supported_formats bounds must match the min_format and max_format major versions.",
        "pack_format must be included in the supported_formats range."
      ]
    );
  });

  it("requires legacy compatibility fields whenever a pack range includes format 64", async () => {
    const document = createJsonDocument(path.join("pack", "pack.mcmeta"), {
      pack: {
        ["min_format"]: 34,
        ["max_format"]: 64,
        description: "test"
      }
    });

    const diagnostics = await getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.filter(diagnostic => diagnostic.severity === "warning").map(diagnostic => [
        diagnostic.message.message,
        diagnostic.message.args
      ]),
      [
        ["Resource pack ranges that include format 64 or earlier must include {0}.", ["pack_format"]],
        ["Resource pack ranges that include format 64 or earlier must include {0}.", ["supported_formats"]]
      ]
    );
  });

  it("keeps overlay legacy declarations present and aligned across the metadata block", async () => {
    const document = createJsonDocument(path.join("pack", "pack.mcmeta"), {
      pack: {
        ["min_format"]: 34,
        ["max_format"]: 88,
        ["pack_format"]: 64,
        ["supported_formats"]: [34, 88],
        description: "test"
      },
      overlays: {
        entries: [
          {
            directory: "legacy",
            ["min_format"]: 34,
            ["max_format"]: 64,
            formats: [34, 64]
          },
          {
            directory: "crossing",
            ["min_format"]: 34,
            ["max_format"]: 88,
            formats: [34, 64]
          },
          {
            directory: "modern",
            ["min_format"]: 88,
            ["max_format"]: 88
          }
        ]
      }
    });

    const diagnostics = await getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.filter(diagnostic => diagnostic.severity === "warning").map(diagnostic => diagnostic.message.message),
      [
        "Overlay formats bounds must match the min_format and max_format major versions.",
        "When any overlay supports format 64 or earlier, every overlay entry must include formats."
      ]
    );
  });

  it("reports post effect passes whose input and output targets are undeclared or identical", async () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "post_effect", "semantic_core_blur.json"),
      {
        targets: {
          swap: {}
        },
        passes: [
          {
            inputs: [
              { ["sampler_name"]: "In", target: "minecraft:undeclared" }
            ],
            output: "typo"
          },
          {
            inputs: [
              { ["sampler_name"]: "In", target: "swap" }
            ],
            output: "swap"
          }
        ]
      }
    );

    const diagnostics = await getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.map(diagnostic => [diagnostic.message.message, diagnostic.message.args ?? []]),
      [
        ["Post effect output target '{0}' is not declared in targets.", ["typo"]],
        ["Post effect input target '{0}' is not declared in targets.", ["minecraft:undeclared"]],
        ["Post effect pass input target must not be the same as its output target.", []]
      ]
    );
  });

  it("accepts all seven builtin post-effect inputs and keeps non-main builtins read-only", async () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "post_effect", "builtin_targets.json"),
      {
        targets: { source: {}, out: {} },
        passes: [
          {
            inputs: [
              "minecraft:main",
              "minecraft:translucent",
              "minecraft:item_entity",
              "minecraft:particles",
              "minecraft:weather",
              "minecraft:clouds",
              "minecraft:entity_outline",
              "source"
            ].map(target => ({ target })),
            output: "out"
          },
          { inputs: [{ target: "source" }], output: "minecraft:main" },
          { inputs: [{ target: "source" }], output: "minecraft:clouds" }
        ]
      }
    );

    const diagnostics = await getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.map(diagnostic => [diagnostic.message.message, diagnostic.message.args]),
      [["Post effect output target '{0}' is a read-only builtin target.", ["minecraft:clouds"]]]
    );
  });

  it("validates nine-slice border sums and waypoint distance ordering", async () => {
    const textureDocument = createJsonDocument(
      path.join("pack", "assets", "minecraft", "textures", "gui", "button.png.mcmeta"),
      {
        gui: {
          scaling: {
            type: "nine_slice",
            width: 10,
            height: 8,
            border: { left: 6, right: 4, top: 4, bottom: 4 }
          }
        }
      }
    );
    const waypointDocument = createJsonDocument(
      path.join("pack", "assets", "custom", "waypoint_style", "too_near.json"),
      { ["near_distance"]: 128, ["far_distance"]: 128, sprites: ["custom:dot"] }
    );

    const textureDiagnostics = await getSemanticDiagnostics(textureDocument, createOptions());
    const waypointDiagnostics = await getSemanticDiagnostics(waypointDocument, createOptions());

    assert.deepStrictEqual(
      textureDiagnostics.map(diagnostic => diagnostic.message.message),
      [
        "Nine-slice left and right borders must add up to less than width.",
        "Nine-slice top and bottom borders must add up to less than height."
      ]
    );
    assert.deepStrictEqual(
      waypointDiagnostics.map(diagnostic => diagnostic.message.message),
      ["Waypoint far_distance must be greater than near_distance."]
    );
  });

  it("applies waypoint distance defaults when either threshold is omitted", async () => {
    const waypointPath = path.join("pack", "assets", "custom", "waypoint_style", "defaults.json");
    const nearOnlyDiagnostics = await getSemanticDiagnostics(
      createJsonDocument(waypointPath, { ["near_distance"]: 400, sprites: ["custom:dot"] }),
      createOptions()
    );
    const farOnlyDiagnostics = await getSemanticDiagnostics(
      createJsonDocument(waypointPath, { ["far_distance"]: 100, sprites: ["custom:dot"] }),
      createOptions()
    );
    const omittedDiagnostics = await getSemanticDiagnostics(
      createJsonDocument(waypointPath, { sprites: ["custom:dot"] }),
      createOptions()
    );

    assert.deepStrictEqual(
      nearOnlyDiagnostics.map(diagnostic => diagnostic.message.message),
      ["Waypoint far_distance must be greater than near_distance."]
    );
    assert.deepStrictEqual(
      farOnlyDiagnostics.map(diagnostic => diagnostic.message.message),
      ["Waypoint far_distance must be greater than near_distance."]
    );
    assert.deepStrictEqual(omittedDiagnostics, []);
  });

  it("validates sound entries for extensions, whitespace, numeric ranges, and event references", async () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "customcore", "sounds.json"),
      {
        ["entity.example.ambient"]: {
          sounds: [
            "entity/example/keeps_extension.ogg",
            "entity/example/has whitespace",
            {
              name: "entity/example/ok",
              volume: 0
            },
            {
              name: "customcore:entity.example.missing",
              type: "event"
            }
          ]
        }
      }
    );

    const diagnostics = await getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.map(diagnostic => diagnostic.message.message),
      [
        "Sound file references should omit the .ogg extension.",
        "Sound file names must not contain whitespace; Minecraft may ignore the whole sounds.json.",
        "Invalid sounds[].{0}; Minecraft ignores the whole sounds.json when name, volume, or pitch is invalid.",
        "Sound event '{0}' is not defined in sounds.json."
      ]
    );
    assert.deepStrictEqual(diagnostics[3].message.args, ["customcore:entity.example.missing"]);
  });

  it("loads cross-namespace sound events through the host", async () => {
    const requestedFiles: string[] = [];
    const document = createJsonDocument(
      path.join("pack", "assets", "customcore", "sounds.json"),
      {
        ["entity.example.ambient"]: {
          sounds: [{ name: "minecraft:entity.example.missing", type: "event" }]
        }
      }
    );
    const host = createHost({
      getSoundEventGraph: async soundsJsonPath => {
        requestedFiles.push(soundsJsonPath);
        return createSoundEventGraph("minecraft", {
          ["entity.example.present"]: { sounds: [] }
        });
      }
    });

    const diagnostics = await getSemanticDiagnostics(document, createOptions(host));

    assert.strictEqual(requestedFiles.length, 1);
    assert.strictEqual(requestedFiles[0], path.join("pack", "assets", "minecraft", "sounds.json"));
    assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.message.args), [["minecraft:entity.example.missing"]]);
  });

  it("detects direct and indirect local sound-event reference cycles", async () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "customcore", "sounds.json"),
      {
        a: { sounds: [{ name: "a", type: "event" }] },
        b: { sounds: [{ name: "customcore:c", type: "event" }] },
        c: { sounds: [{ name: "b", type: "event" }] },
        entry: { sounds: [{ name: "b", type: "event" }] },
        root: { sounds: [{ name: "left", type: "event" }, { name: "right", type: "event" }] },
        right: { sounds: [{ name: "left", type: "event" }] },
        left: { sounds: [] }
      }
    );

    const diagnostics = await getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.map(diagnostic => [diagnostic.message.message, diagnostic.message.args]),
      [
        ["Sound event '{0}' directly or indirectly references itself.", ["a"]],
        ["Sound event '{0}' directly or indirectly references itself.", ["customcore:c"]],
        ["Sound event '{0}' directly or indirectly references itself.", ["b"]]
      ]
    );
  });

  it("detects sound-event cycles that cross namespace sounds.json files", async () => {
    const requestedFiles: string[] = [];
    const document = createJsonDocument(
      path.join("pack", "assets", "alpha", "sounds.json"),
      {
        a: { sounds: [{ name: "beta:b", type: "event" }] }
      }
    );
    const host = createHost({
      getSoundEventGraph: async soundsJsonPath => {
        requestedFiles.push(soundsJsonPath);
        return createSoundEventGraph("beta", {
          b: { sounds: [{ name: "alpha:a", type: "event" }] }
        });
      }
    });

    const diagnostics = await getSemanticDiagnostics(document, createOptions(host));

    assert.deepStrictEqual(requestedFiles, [path.join("pack", "assets", "beta", "sounds.json")]);
    assert.deepStrictEqual(
      diagnostics.map(diagnostic => [diagnostic.message.message, diagnostic.message.args]),
      [["Sound event '{0}' directly or indirectly references itself.", ["beta:b"]]]
    );
  });

  it("detects cyclic texture variable chains in model documents", async () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "models", "block", "semantic_core_cycle.json"),
      {
        textures: {
          a: "#b",
          b: "#a",
          plain: "minecraft:block/stone"
        }
      }
    );

    const diagnostics = await getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.map(diagnostic => [diagnostic.severity, diagnostic.message.message, diagnostic.message.args ?? []]),
      [
        ["warning", "Texture variable '{0}' contains a cyclic # reference chain.", ["a"]],
        ["warning", "Texture variable '{0}' contains a cyclic # reference chain.", ["b"]]
      ]
    );
  });

  it("reports parent-chain cycle and depth termination reasons", async () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "models", "block", "child.json"),
      { parent: "minecraft:block/parent" }
    );
    const ast = parseJsonAst(document.getText());
    assert.ok(ast);

    const cycleDiagnostics = await getSemanticDiagnostics(document, createOptions(createHost({
      getModelParentChain: () => ({
        models: [{ ast }],
        issue: { kind: "cycle", fileName: document.fileName }
      })
    })));
    const depthDiagnostics = await getSemanticDiagnostics(document, createOptions(createHost({
      getModelParentChain: () => ({
        models: [{ ast }],
        issue: { kind: "depth", fileName: "too-deep.json", maxDepth: 10 }
      })
    })));

    assert.deepStrictEqual(
      cycleDiagnostics.map(diagnostic => diagnostic.message.message),
      ["Model parent chain contains a cyclic parent reference."]
    );
    assert.deepStrictEqual(
      depthDiagnostics.map(diagnostic => diagnostic.message.message),
      ["Model parent chain exceeds Minecraft's maximum depth of 10."]
    );
  });

  it("awaits text bytes from the host without synchronous filesystem access", async () => {
    const fileName = path.join("pack", "assets", "minecraft", "texts", "end.txt");
    const requestedFiles: string[] = [];
    const document: SemanticDiagnosticsDocument = {
      languageId: "plaintext",
      fileName,
      getText: () => "Hello PLAYERNAME"
    };
    const host = createHost({
      readFileBytes: async requestedFileName => {
        await Promise.resolve();
        requestedFiles.push(requestedFileName);
        return Uint8Array.of(0xff);
      }
    });

    const diagnostics = await getSemanticDiagnostics(document, createOptions(host));

    assert.deepStrictEqual(requestedFiles, [fileName]);
    assert.deepStrictEqual(
      diagnostics.map(diagnostic => diagnostic.message.message),
      ["Text resource files must be valid UTF-8."]
    );
  });

  it("continues text diagnostics when the host cannot read bytes", async () => {
    const document: SemanticDiagnosticsDocument = {
      languageId: "plaintext",
      fileName: path.join("pack", "assets", "minecraft", "texts", "end.txt"),
      getText: () => "Hello playername"
    };
    const host = createHost({
      readFileBytes: async () => {
        throw new Error("unreadable");
      }
    });

    const diagnostics = await getSemanticDiagnostics(document, createOptions(host));

    assert.deepStrictEqual(
      diagnostics.map(diagnostic => diagnostic.message.message),
      ["Only uppercase PLAYERNAME is replaced with the current player name."]
    );
  });
});

function createOptions(host = createHost()): SemanticDiagnosticsOptions {
  return {
    configuration: { defaultAssetsPath: null, resourcePackRoots: [] },
    localize: message => message.message,
    host
  };
}

function createHost(overrides: Partial<SemanticDiagnosticsHost> = {}): SemanticDiagnosticsHost {
  const host: SemanticDiagnosticsHost = {
    getJsonAst: document => parseJsonAst(document.getText()),
    readFileBytes: async () => undefined,
    getPackImageResourceIssues: packRoot => [{
      filePath: path.join(packRoot, "pack.png"),
      message: lm("pack.png is missing; Minecraft will use the default unknown pack icon."),
      severity: "information"
    }],
    getModelParentChain: (_document, ast) => ({ models: [{ ast }], issue: null }),
    getSoundEventGraph: async () => null
  };
  return { ...host, ...overrides };
}

function createThrowingHost(): SemanticDiagnosticsHost {
  const unexpected = (): never => {
    throw new Error("Host must not be used for unrelated documents");
  };
  return {
    getJsonAst: unexpected,
    readFileBytes: async () => unexpected(),
    getPackImageResourceIssues: unexpected,
    getModelParentChain: unexpected,
    getSoundEventGraph: unexpected
  };
}

function createSoundEventGraph(namespace: string, value: unknown) {
  const ast = parseJsonAst(JSON.stringify(value));
  assert.ok(ast);
  return buildSoundEventFileGraph(ast, namespace);
}

function createJsonDocument(fileName: string, value: unknown): SemanticDiagnosticsDocument {
  return {
    languageId: "json",
    fileName,
    getText: () => JSON.stringify(value, null, 2)
  };
}
