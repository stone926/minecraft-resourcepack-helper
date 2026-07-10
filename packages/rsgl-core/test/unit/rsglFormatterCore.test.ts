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
});
