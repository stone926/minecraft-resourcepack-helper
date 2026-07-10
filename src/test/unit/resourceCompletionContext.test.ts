import * as assert from "node:assert";
import * as path from "node:path";
import { inferIncompleteResourceCompletionContext } from "../../utils/resourceCompletionContext";
import { ResourceReferenceDocument } from "../../utils/resourceReferences";

describe("resource completion context", () => {
  it("infers model texture references for missing values", () => {
    const { document, position } = createMarkedJsonDocument(
      path.join("pack", "assets", "minecraft", "models", "block", "slab.json"),
      [
        "{",
        "  \"parent\": \"minecraft:block/slab\",",
        "  \"textures\": {",
        "    \"side\": |",
        "  }",
        "}"
      ].join("\n")
    );

    const context = inferIncompleteResourceCompletionContext(document, position);

    assert.strictEqual(context?.reference.kind, "texture");
    assert.strictEqual(context.reference.value, "");
    assert.strictEqual(context.reference.target, "textures");
    assert.strictEqual(context.reference.source, "models/block");
    assert.strictEqual(context.reference.extension, "png");
    assert.strictEqual(context.includeQuotes, true);
    assert.deepStrictEqual(context.replacementRange, { start: position, end: position });
  });

  it("infers model texture references for unclosed strings", () => {
    const { document, position } = createMarkedJsonDocument(
      path.join("pack", "assets", "minecraft", "models", "block", "slab.json"),
      [
        "{",
        "  \"parent\": \"minecraft:block/slab\",",
        "  \"textures\": {",
        "    \"side\": \"minecraft:block/qu|",
        "  }",
        "}"
      ].join("\n")
    );

    const context = inferIncompleteResourceCompletionContext(document, position);

    assert.strictEqual(context?.reference.kind, "texture");
    assert.strictEqual(context.reference.value, "minecraft:block/qu");
    assert.strictEqual(context.includeQuotes, false);
    assert.deepStrictEqual(context.replacementRange, {
      start: { line: 3, character: 13 },
      end: position
    });
  });

  it("infers parent model references for missing values", () => {
    const { document, position } = createMarkedJsonDocument(
      path.join("pack", "assets", "minecraft", "models", "item", "custom.json"),
      [
        "{",
        "  \"parent\": |",
        "}"
      ].join("\n")
    );

    const context = inferIncompleteResourceCompletionContext(document, position);

    assert.strictEqual(context?.reference.kind, "model");
    assert.strictEqual(context.reference.relationship, "modelParent");
    assert.strictEqual(context.reference.target, "models");
    assert.strictEqual(context.reference.source, "models/item");
    assert.strictEqual(context.reference.extension, "json");
    assert.strictEqual(context.includeQuotes, true);
  });

  it("uses the CIT model file location as the completion source", () => {
    const fileName = path.join(
      "pack",
      "assets",
      "example",
      "citresewn",
      "cit",
      "tools",
      "hammer.json"
    );
    const { document, position } = createMarkedJsonDocument(
      fileName,
      [
        "{",
        "  \"textures\": {",
        "    \"layer0\": \"./|",
        "  }",
        "}"
      ].join("\n")
    );

    const context = inferIncompleteResourceCompletionContext(document, position);

    assert.strictEqual(context?.reference.kind, "texture");
    assert.strictEqual(context.reference.source, "citresewn/cit/tools");
    assert.strictEqual(context.reference.resolveMode, "cit");
  });

  it("does not infer non-resource missing values", () => {
    const { document, position } = createMarkedJsonDocument(
      path.join("pack", "assets", "minecraft", "models", "block", "display.json"),
      [
        "{",
        "  \"display\": {",
        "    \"gui\": {",
        "      \"scale\": |",
        "    }",
        "  }",
        "}"
      ].join("\n")
    );

    assert.strictEqual(inferIncompleteResourceCompletionContext(document, position), null);
  });
});

function createMarkedJsonDocument(fileName: string, markedText: string): {
  document: ResourceReferenceDocument;
  position: { line: number; character: number };
} {
  const markerOffset = markedText.indexOf("|");
  assert.notStrictEqual(markerOffset, -1, "test document must contain a cursor marker");
  const text = `${markedText.slice(0, markerOffset)}${markedText.slice(markerOffset + 1)}`;

  return {
    document: {
      languageId: "json",
      fileName,
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
