import * as assert from "node:assert";
import * as path from "node:path";
import { getCitCompletionResult, getCitHoverInfo, type CitLanguageDocument } from "../../utils/citLanguage";

describe("CIT completion and hover", () => {
  it("completes keys from the effective item spec", () => {
    const { document, position } = createMarkedDocument([
      "type=item",
      "|"
    ].join("\n"));

    const result = getCitCompletionResult(document, position, "en");
    const labels = result?.candidates.map(candidate => candidate.label) ?? [];

    assert.ok(labels.includes("items"));
    assert.ok(labels.includes("texture"));
    assert.ok(labels.includes("model."));
  });

  it("filters keys by CIT type", () => {
    const { document, position } = createMarkedDocument([
      "type=armor",
      "|"
    ].join("\n"));

    const result = getCitCompletionResult(document, position, "en");
    const labels = result?.candidates.map(candidate => candidate.label) ?? [];

    assert.ok(labels.includes("texture."));
    assert.strictEqual(labels.includes("model"), false);
  });

  it("completes enum and boolean values", () => {
    const typeValue = getCitCompletionResult(createMarkedDocument("type=e|").document, createMarkedDocument("type=e|").position, "en");
    assert.deepStrictEqual(typeValue?.candidates.map(candidate => candidate.label), ["elytra", "enchantment"]);

    const { document, position } = createMarkedDocument([
      "type=enchantment",
      "blur=|"
    ].join("\n"));
    const booleanValue = getCitCompletionResult(document, position, "en");

    assert.deepStrictEqual(booleanValue?.candidates.map(candidate => candidate.label), ["true", "false"]);
  });

  it("returns hover content from the spec", () => {
    const { document, position } = createMarkedDocument("hand|=main");

    const hover = getCitHoverInfo(document, position, "en");

    assert.strictEqual(hover?.title, "Hand");
    assert.strictEqual(hover?.valueType, "enum");
    assert.deepStrictEqual(hover?.appliesTo, ["base"]);
  });
});

function createMarkedDocument(markedText: string): {
  document: CitLanguageDocument;
  position: { line: number; character: number };
} {
  const markerOffset = markedText.indexOf("|");
  assert.notStrictEqual(markerOffset, -1);
  const text = `${markedText.slice(0, markerOffset)}${markedText.slice(markerOffset + 1)}`;
  return {
    document: {
      fileName: path.join("pack", "assets", "minecraft", "citresewn", "cit", "sword.properties"),
      getText: () => text
    },
    position: positionAt(text, markerOffset)
  };
}

function positionAt(text: string, offset: number): { line: number; character: number } {
  const lines = text.slice(0, offset).split("\n");
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length
  };
}
