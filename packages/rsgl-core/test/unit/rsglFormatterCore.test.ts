import * as assert from "node:assert";
import { formatRsglText } from "../../src/formatterCore";

describe("RSGL formatter core", () => {
  it("formats indentation without changing source content inside strings", () => {
    const formatted = formatRsglText([
      "model block stone {",
      "parent minecraft:block/cube_all  ",
      "textures {",
      "all: `minecraft:block/${name}`",
      "}",
      "}"
    ].join("\n"));

    assert.strictEqual(formatted, [
      "model block stone {",
      "  parent minecraft:block/cube_all",
      "  textures {",
      "    all: `minecraft:block/${name}`",
      "  }",
      "}"
    ].join("\n"));
  });

  it("formats base and merge statements without changing their modifiers", () => {
    const formatted = formatRsglText([
      "model block patched {",
      "base \"./base.json\"",
      "merge deep {",
      "display: {",
      "gui: { scale: [1, 1, 1] }",
      "}",
      "}",
      "merge strict { parent: minecraft:block/base }",
      "}"
    ].join("\n"));

    assert.strictEqual(formatted, [
      "model block patched {",
      "  base \"./base.json\"",
      "  merge deep {",
      "    display: {",
      "      gui: { scale: [1, 1, 1] }",
      "    }",
      "  }",
      "  merge strict { parent: minecraft:block/base }",
      "}"
    ].join("\n"));
  });

  it("keeps explicit template output headers and nested bodies idempotent", () => {
    const source = [
      "template hopperBowl(",
      "tex: TextureRef",
      ") -> model {",
      "for y in [0, 8] {",
      "if true {",
      "element from [0, y, 0] to [16, y + 4, 16] { face up texture tex }",
      "}",
      "}",
      "}"
    ].join("\n");
    const formatted = formatRsglText(source);

    assert.ok(formatted.includes(") -> model {"));
    assert.strictEqual(formatRsglText(formatted), formatted);
  });
});
