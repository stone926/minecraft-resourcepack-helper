import * as assert from "node:assert";
import { getRsglCompletionItems } from "../../src/completionService";
import type { RsglSymbol } from "../../src/semantic";

function symbol(name: string, kind: RsglSymbol["kind"], typeKind: RsglSymbol["type"]["kind"]): RsglSymbol {
  return {
    name,
    kind,
    type: { kind: typeKind },
    signature: kind === "template"
      ? { parameters: [], returnType: { kind: "Unknown" } }
      : undefined
  };
}

describe("RSGL completion service", () => {
  it("merges syntax candidates with workspace semantic symbols", () => {
    const items = getRsglCompletionItems("", 0, [
      symbol("makeCube", "template", "Function"),
      symbol("palette", "table", "Object"),
      symbol("stoneModel", "resource", "ModelId"),
      symbol("texture", "variable", "TextureId")
    ]);

    assert.strictEqual(items.find(item => item.label === "target")?.kind, "snippet");
    assert.deepStrictEqual(items.find(item => item.label === "makeCube"), {
      label: "makeCube",
      kind: "function",
      detail: "template: makeCube(): Unknown"
    });
    assert.deepStrictEqual(items.find(item => item.label === "palette"), {
      label: "palette",
      kind: "struct",
      detail: "table: {}"
    });
    assert.deepStrictEqual(items.find(item => item.label === "stoneModel"), {
      label: "stoneModel",
      kind: "file",
      detail: "resource: ModelId"
    });
    assert.deepStrictEqual(items.find(item => item.label === "texture"), {
      label: "texture",
      kind: "variable",
      detail: "variable: TextureId"
    });
  });

  it("keeps syntax candidates when a workspace symbol has the same label", () => {
    const matches = getRsglCompletionItems("", 0, [symbol("target", "template", "Function")])
      .filter(item => item.label === "target");

    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].kind, "snippet");
  });

  it("presents linked template output metadata for local and imported symbols", () => {
    const explicit: RsglSymbol = {
      name: "states",
      kind: "import",
      type: { kind: "Function" },
      signature: {
        parameters: [],
        returnType: { kind: "Json" },
        templateOutput: { outputSource: "explicitArrow", outputDialect: "variants" }
      }
    };
    const item = getRsglCompletionItems("", 0, [explicit]).find(candidate => candidate.label === "states");

    assert.deepStrictEqual(item, {
      label: "states",
      kind: "function",
      detail: "import: states(): Json — template -> variants"
    });
  });

  it("keeps ModelSpec option-key completion exclusive of values and builtins", () => {
    const text = [
      "blockstate variants stone {",
      "  case * => minecraft:block/stone with {",
      "    "
    ].join("\n");
    const items = getRsglCompletionItems(text, text.length, [
      symbol("localRotation", "variable", "Number")
    ]);

    assert.deepStrictEqual(items.map(item => item.label), ["x", "y", "z", "uvlock"]);
  });
});
