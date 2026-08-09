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

  it("warns when pack.mcmeta keeps pack_format for 1.21.9+ only packs", async () => {
    const document = createJsonDocument(path.join("pack", "pack.mcmeta"), {
      pack: {
        ["min_format"]: [88, 0],
        ["max_format"]: [88, 0],
        ["pack_format"]: 88,
        description: "test"
      }
    });

    const diagnostics = await getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.filter(diagnostic => diagnostic.severity === "warning").map(diagnostic => diagnostic.message.message),
      ["Resource packs that only support 1.21.9+ must not use pack_format or supported_formats."]
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
      getSoundEvents: soundsJsonPath => {
        requestedFiles.push(soundsJsonPath);
        return new Set(["entity.example.present"]);
      }
    });

    const diagnostics = await getSemanticDiagnostics(document, createOptions(host));

    assert.strictEqual(requestedFiles.length, 1);
    assert.strictEqual(requestedFiles[0], path.join("pack", "assets", "minecraft", "sounds.json"));
    assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.message.args), [["minecraft:entity.example.missing"]]);
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
    getModelParentChain: (_document, ast) => [{ ast }],
    getSoundEvents: () => new Set<string>()
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
    getSoundEvents: unexpected
  };
}

function createJsonDocument(fileName: string, value: unknown): SemanticDiagnosticsDocument {
  return {
    languageId: "json",
    fileName,
    getText: () => JSON.stringify(value, null, 2)
  };
}
