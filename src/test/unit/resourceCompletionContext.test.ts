import * as assert from "node:assert/strict";
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
    assert.strictEqual(context.insertPrefix, "\"");
    assert.strictEqual(context.insertSuffix, "\"");
    assert.deepStrictEqual(context.insertingRange, { start: position, end: position });
    assert.deepStrictEqual(context.replacingRange, { start: position, end: position });
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
    assert.strictEqual(context.insertPrefix, "");
    assert.strictEqual(context.insertSuffix, "\"");
    assert.deepStrictEqual(context.insertingRange, {
      start: { line: 3, character: 13 },
      end: position
    });
    assert.deepStrictEqual(context.replacingRange, context.insertingRange);
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
    assert.strictEqual(context.insertPrefix, "\"");
    assert.strictEqual(context.insertSuffix, "\"");
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

  it("keeps completion available when another JSON value is temporarily missing", () => {
    const { document, position } = createMarkedJsonDocument(
      path.join("pack", "assets", "minecraft", "models", "block", "slab.json"),
      [
        "{",
        "  \"textures\": {",
        "    \"side\": \"minecraft:block/qu|artz\",",
        "    \"top\":",
        "  },",
        "}"
      ].join("\n")
    );

    const context = inferIncompleteResourceCompletionContext(document, position);

    assert.strictEqual(context?.reference.kind, "texture");
    assert.strictEqual(context.reference.value, "minecraft:block/qu");
    assert.deepStrictEqual(context.insertingRange.end, position);
    assert.deepStrictEqual(context.replacingRange.end, { line: 2, character: 35 });
    assert.strictEqual(context.insertSuffix, "");
  });

  it("infers empty and partial angle shader imports before a closing delimiter exists", () => {
    const empty = createMarkedDocument(
      path.join("pack", "assets", "minecraft", "shaders", "core", "entity.vsh"),
      "#moj_import <|",
      "glsl"
    );
    const partial = createMarkedDocument(
      path.join("pack", "assets", "minecraft", "shaders", "include", "fog.glsl"),
      "#moj_import <custom:lighting/|",
      "glsl"
    );

    const emptyContext = inferIncompleteResourceCompletionContext(empty.document, empty.position);
    const partialContext = inferIncompleteResourceCompletionContext(partial.document, partial.position);

    assert.strictEqual(emptyContext?.reference.value, "");
    assert.strictEqual(emptyContext?.reference.target, "shaders/include");
    assert.strictEqual(emptyContext?.insertSuffix, ">");
    assert.strictEqual(partialContext?.reference.value, "custom:lighting/");
    assert.strictEqual(partialContext?.reference.source, "shaders/include");
  });

  it("infers quoted shader imports relative to the current shader directory", () => {
    const { document, position } = createMarkedDocument(
      path.join("pack", "assets", "minecraft", "shaders", "post", "nested", "blur.fsh"),
      "#moj_import \"../shared/|",
      "glsl"
    );

    const context = inferIncompleteResourceCompletionContext(document, position);

    assert.strictEqual(context?.reference.target, "shaders/post/nested");
    assert.strictEqual(context?.reference.source, "shaders/post/nested");
    assert.strictEqual(context?.reference.resolveMode, "relative");
    assert.strictEqual(context?.insertSuffix, "\"");
  });
});

function createMarkedJsonDocument(fileName: string, markedText: string): {
  document: ResourceReferenceDocument;
  position: { line: number; character: number };
} {
  return createMarkedDocument(fileName, markedText, "json");
}

function createMarkedDocument(fileName: string, markedText: string, languageId: string): {
  document: ResourceReferenceDocument;
  position: { line: number; character: number };
} {
  const markerOffset = markedText.indexOf("|");
  assert.notStrictEqual(markerOffset, -1, "test document must contain a cursor marker");
  const text = `${markedText.slice(0, markerOffset)}${markedText.slice(markerOffset + 1)}`;

  return {
    document: {
      languageId,
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
