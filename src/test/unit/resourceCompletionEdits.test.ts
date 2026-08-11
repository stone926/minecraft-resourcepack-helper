import * as assert from "node:assert/strict";
import {
  buildResourceCompletionInsertion,
  decodeJsonStringContent
} from "../../utils/resourceCompletionEdits";

describe("resource completion edits", () => {
  it("closes an unterminated JSON string after accepting a file", () => {
    const insertion = buildResourceCompletionInsertion(
      "minecraft:block/quartz",
      "jsonString",
      "",
      "\"",
      false
    );

    assert.strictEqual(insertion.snippet, true);
    assert.strictEqual(renderSnippet(insertion.text), "minecraft:block/quartz\"");
    assert.strictEqual(JSON.parse(`"${renderSnippet(insertion.text)}`), "minecraft:block/quartz");
  });

  it("keeps the cursor inside a synthesized delimiter while completing directories", () => {
    const insertion = buildResourceCompletionInsertion(
      "minecraft:block/",
      "jsonString",
      "\"",
      "\"",
      true
    );

    assert.strictEqual(insertion.text, "\"minecraft:block/$0\"");
    assert.strictEqual(renderSnippet(insertion.text), "\"minecraft:block/\"");
  });

  it("escapes host JSON syntax before escaping snippet metacharacters", () => {
    const value = "folder/quoted\"back\\slash$}.png";
    const insertion = buildResourceCompletionInsertion(value, "jsonString", "\"", "\"", false);
    const rendered = renderSnippet(insertion.text);

    assert.strictEqual(JSON.parse(rendered), value);
  });

  it("decodes a valid JSON string prefix and rejects a cursor inside an escape", () => {
    assert.strictEqual(decodeJsonStringContent("folder\\/stone"), "folder/stone");
    assert.strictEqual(decodeJsonStringContent("folder\\"), null);
  });
});

function renderSnippet(value: string): string {
  return value
    .replaceAll("$0", "")
    .replace(/\\([\\$}])/g, "$1");
}
