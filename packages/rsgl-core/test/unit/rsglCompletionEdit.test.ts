import * as assert from "node:assert/strict";
import { getRsglCompletionItems } from "../../src/completionService";

describe("RSGL completion edits", () => {
  it("separates semantic item kind from snippet insertion format", () => {
    const topLevel = getRsglCompletionItems("", 0);
    const blockText = "model block stone {\n  ";
    const block = getRsglCompletionItems(blockText, blockText.length);

    const seq = topLevel.find(item => item.label === "seq");
    const parent = block.find(item => item.label === "parent");

    assert.strictEqual(seq?.kind, "function");
    assert.strictEqual(seq?.insertTextFormat, "snippet");
    assert.strictEqual(parent?.kind, "property");
    assert.strictEqual(parent?.insertTextFormat, "snippet");
  });

  it("replaces a complete token suffix without touching adjacent syntax", () => {
    const text = "replace";
    const item = getRsglCompletionItems(text, 3).find(candidate => candidate.label === "replace");

    assert.deepStrictEqual(item?.edit, {
      insert: { start: 0, end: 3 },
      replace: { start: 0, end: 7 },
      newText: "replace(${1:str}, ${2:old}, ${3:new})"
    });
  });

  it("extends edits across an already typed multi-word snippet prefix", () => {
    const text = "model b";
    const item = getRsglCompletionItems(text, text.length)
      .find(candidate => candidate.label === "model block");

    assert.strictEqual(item?.edit?.insert.start, 0);
    assert.strictEqual(item?.edit?.replace.start, 0);
    assert.match(item?.edit?.newText ?? "", /^model block /);
  });

  it("replaces an existing multi-word suffix when completing in the phrase", () => {
    const modelText = "model block";
    const modelItem = getRsglCompletionItems(modelText, "model".length)
      .find(candidate => candidate.label === "model block");
    const templateText = "template -> variants";
    const templateItem = getRsglCompletionItems(templateText, "template".length)
      .find(candidate => candidate.label === "template -> variants");

    assert.deepStrictEqual(modelItem?.edit?.replace, { start: 0, end: modelText.length });
    assert.deepStrictEqual(templateItem?.edit?.replace, { start: 0, end: templateText.length });
  });

  it("uses the whole resource location as the replace range", () => {
    const text = "item example {\n  select property minecraft:compo|nent";
    const offset = text.indexOf("|");
    const source = text.replace("|", "");
    const item = getRsglCompletionItems(source, offset)
      .find(candidate => candidate.label === "minecraft:component");
    const start = source.indexOf("minecraft:component");

    assert.deepStrictEqual(item?.edit?.insert, { start, end: offset });
    assert.deepStrictEqual(item?.edit?.replace, {
      start,
      end: start + "minecraft:component".length
    });
  });

  it("suppresses syntax completions in comments and string/template contents", () => {
    const comment = "model block stone {\n  // rep";
    const string = "model block stone {\n  parent \"minecraft:block/st";
    const template = "model block stone {\n  let value = `raw.text";

    assert.deepStrictEqual(getRsglCompletionItems(comment, comment.length), []);
    assert.deepStrictEqual(getRsglCompletionItems(string, string.length), []);
    assert.deepStrictEqual(getRsglCompletionItems(template, template.length), []);
  });
});
