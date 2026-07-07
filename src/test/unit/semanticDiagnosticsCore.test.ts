import * as assert from "node:assert";
import * as path from "node:path";
import {
  getSemanticDiagnostics,
  isSemanticDiagnosticsDocument,
  type SemanticDiagnosticsDocument,
  type SemanticDiagnosticsOptions
} from "../../diagnostics/semanticDiagnosticsCore";
import { createTempDirectory, removeTempDirectory } from "./helpers/tempPack";

describe("semantic diagnostics core", () => {
  it("ignores documents outside the semantic diagnostic domains without reading them", () => {
    const document: SemanticDiagnosticsDocument = {
      languageId: "json",
      fileName: path.join("pack", "data", "recipe.json"),
      getText: () => {
        throw new Error("Unrelated JSON should not be parsed");
      }
    };

    assert.strictEqual(isSemanticDiagnosticsDocument(document), false);
    assert.deepStrictEqual(getSemanticDiagnostics(document, createOptions()), []);
  });

  it("flags pack.mcmeta files that use min_format without max_format and localizes pack image issues", () => {
    const root = createTempDirectory();

    try {
      const document = createJsonDocument(path.join(root, "pack.mcmeta"), {
        pack: {
          ["min_format"]: [88, 0],
          description: "test"
        }
      });

      const diagnostics = getSemanticDiagnostics(document, createOptions());

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
    } finally {
      removeTempDirectory(root);
    }
  });

  it("warns when pack.mcmeta keeps pack_format for 1.21.9+ only packs", () => {
    const root = createTempDirectory();

    try {
      const document = createJsonDocument(path.join(root, "pack.mcmeta"), {
        pack: {
          ["min_format"]: [88, 0],
          ["max_format"]: [88, 0],
          ["pack_format"]: 88,
          description: "test"
        }
      });

      const diagnostics = getSemanticDiagnostics(document, createOptions());

      assert.deepStrictEqual(
        diagnostics.filter(diagnostic => diagnostic.severity === "warning").map(diagnostic => diagnostic.message.message),
        ["Resource packs that only support 1.21.9+ must not use pack_format or supported_formats."]
      );
    } finally {
      removeTempDirectory(root);
    }
  });

  it("reports post effect passes whose input and output targets are undeclared or identical", () => {
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

    const diagnostics = getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.map(diagnostic => [diagnostic.message.message, diagnostic.message.args ?? []]),
      [
        ["Post effect output target '{0}' is not declared in targets.", ["typo"]],
        ["Post effect input target '{0}' is not declared in targets.", ["minecraft:undeclared"]],
        ["Post effect pass input target must not be the same as its output target.", []]
      ]
    );
  });

  it("validates sound entries for extensions, whitespace, numeric ranges, and event references", () => {
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

    const diagnostics = getSemanticDiagnostics(document, createOptions());

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

  it("detects cyclic texture variable chains in model documents", () => {
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

    const diagnostics = getSemanticDiagnostics(document, createOptions());

    assert.deepStrictEqual(
      diagnostics.map(diagnostic => [diagnostic.severity, diagnostic.message.message, diagnostic.message.args ?? []]),
      [
        ["warning", "Texture variable '{0}' contains a cyclic # reference chain.", ["a"]],
        ["warning", "Texture variable '{0}' contains a cyclic # reference chain.", ["b"]]
      ]
    );
  });
});

function createOptions(): SemanticDiagnosticsOptions {
  return {
    configuration: { defaultAssetsPath: null, resourcePackRoots: [] },
    localize: message => message.message
  };
}

function createJsonDocument(fileName: string, value: unknown): SemanticDiagnosticsDocument {
  return {
    languageId: "json",
    fileName,
    getText: () => JSON.stringify(value, null, 2)
  };
}
