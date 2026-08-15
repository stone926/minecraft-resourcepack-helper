import * as assert from "node:assert/strict";
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

function zeroWidthEdit(newText: string) {
  return {
    insert: { start: 0, end: 0 },
    replace: { start: 0, end: 0 },
    newText
  };
}

describe("RSGL completion service", () => {
  it("keeps completion responsive for expressions beyond the parser nesting limit", () => {
    const text = `let nested = ${"[".repeat(2_048)}value`;

    assert.doesNotThrow(() => getRsglCompletionItems(text, text.length));
  });

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
      detail: "template: makeCube(): Unknown",
      edit: zeroWidthEdit("makeCube")
    });
    assert.deepStrictEqual(items.find(item => item.label === "palette"), {
      label: "palette",
      kind: "struct",
      detail: "table: {}",
      edit: zeroWidthEdit("palette")
    });
    assert.deepStrictEqual(items.find(item => item.label === "stoneModel"), {
      label: "stoneModel",
      kind: "file",
      detail: "resource: ModelId",
      edit: zeroWidthEdit("stoneModel")
    });
    assert.deepStrictEqual(items.find(item => item.label === "texture"), {
      label: "texture",
      kind: "variable",
      detail: "variable: TextureId",
      edit: zeroWidthEdit("texture")
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
      detail: "import: states(): Json — template -> variants",
      edit: zeroWidthEdit("states")
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

  it("filters template symbols to item_model output in item-model contexts", () => {
    const itemTemplate: RsglSymbol = {
      name: "itemLeaf",
      kind: "template",
      type: { kind: "Function" },
      signature: {
        parameters: [],
        returnType: { kind: "Json" },
        templateOutput: {
          outputSource: "explicitArrow",
          outputDialect: "item_model",
          cardinality: "one"
        }
      }
    };
    const variantsTemplate: RsglSymbol = {
      name: "states",
      kind: "template",
      type: { kind: "Function" },
      signature: {
        parameters: [],
        returnType: { kind: "Json" },
        templateOutput: { outputSource: "explicitArrow", outputDialect: "variants" }
      }
    };
    const text = "item example {\n  ";
    const labels = new Set(
      getRsglCompletionItems(text, text.length, [itemTemplate, variantsTemplate])
        .map(item => item.label)
    );

    assert.ok(labels.has("itemLeaf"));
    assert.strictEqual(labels.has("states"), false);
  });

  it("keeps item-model option-key completion exclusive of symbols and builtins", () => {
    const text = [
      "item example {",
      "  model minecraft:item/example with {",
      "    "
    ].join("\n");
    const items = getRsglCompletionItems(text, text.length, [
      symbol("localTint", "variable", "Number")
    ]);

    assert.deepStrictEqual(items.map(item => item.label).sort(), ["tints", "transformation"]);
  });

  it("keeps schema-derived item header and subtype keys exclusive of value symbols", () => {
    const symbols = [symbol("localValue", "variable", "Number")];
    const header = [
      "item example {",
      "  select property minecraft:component "
    ].join("\n");
    assert.deepStrictEqual(
      getRsglCompletionItems(header, header.length, symbols).map(item => item.label),
      ["component"]
    );

    const special = [
      "item example {",
      "  special base minecraft:item/example model { type: minecraft:shulker_box, "
    ].join("\n");
    const labels = getRsglCompletionItems(special, special.length, symbols).map(item => item.label);
    assert.ok(labels.includes("texture"));
    assert.strictEqual(labels.includes("localValue"), false);
    assert.strictEqual(labels.includes("true"), false);
  });
});
