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

  it("formats nested geometry transforms without changing their header syntax", () => {
    const source = [
      "template panels() -> model {",
      "transform rotate_y(90) around [8, 8, 8] {",
      "transform rotate_x(180) around [8, 8, 8] {",
      "element from [0, 0, 0] to [16, 1, 16] {",
      "up texture \"#top\"",
      "}",
      "}",
      "}",
      "}"
    ].join("\n");
    const formatted = formatRsglText(source);

    assert.strictEqual(formatted, [
      "template panels() -> model {",
      "  transform rotate_y(90) around [8, 8, 8] {",
      "    transform rotate_x(180) around [8, 8, 8] {",
      "      element from [0, 0, 0] to [16, 1, 16] {",
      "        up texture \"#top\"",
      "      }",
      "    }",
      "  }",
      "}"
    ].join("\n"));
    assert.strictEqual(formatRsglText(formatted), formatted);
  });

  it("keeps canonical blockstate choice and ModelSpec bodies stable", () => {
    const formatted = formatRsglText([
      "blockstate variants stairs {",
      "case { facing: north } => random {",
      "option minecraft:block/stairs with { x: 90, uvlock: true } weight 2",
      "option minecraft:block/stairs_inner with { y: 180 }",
      "}",
      "merge deep {",
      "custom: { enabled: true }",
      "}",
      "}"
    ].join("\n"));

    assert.strictEqual(formatted, [
      "blockstate variants stairs {",
      "  case { facing: north } => random {",
      "    option minecraft:block/stairs with { x: 90, uvlock: true } weight 2",
      "    option minecraft:block/stairs_inner with { y: 180 }",
      "  }",
      "  merge deep {",
      "    custom: { enabled: true }",
      "  }",
      "}"
    ].join("\n"));
    assert.strictEqual(formatRsglText(formatted), formatted);
  });

  it("keeps canonical and erroneous arrow tokens stable and idempotent", () => {
    const source = [
      "let canonical = match mode {",
      "north => 1",
      "}",
      "let legacy = match mode {",
      "north -> 1",
      "}",
      "type Correct = (Json) -> ModelId",
      "type Wrong = (Json) => ModelId"
    ].join("\n");

    const formatted = formatRsglText(source);

    assert.ok(formatted.includes("  north => 1"));
    assert.ok(formatted.includes("  north -> 1"));
    assert.ok(formatted.includes("type Correct = (Json) -> ModelId"));
    assert.ok(formatted.includes("type Wrong = (Json) => ModelId"));
    assert.deepStrictEqual(formatted.match(/=>|->/g), source.match(/=>|->/g));
    assert.strictEqual(formatRsglText(formatted), formatted);
  });

  it("keeps recursive item-model continuations aligned to their enclosing braces", () => {
    const source = [
      "item recursive {",
      "first_match {",
      "when property minecraft:component predicate \"enchantments\" value [{ enchantments: minecraft:channeling }] =>",
      "condition property minecraft:using_item {",
      "on_true",
      "empty {}",
      "on_false selected_item {},",
      "} with {",
      "transformation: {",
      "scale: [",
      "1,",
      "1,",
      "1,",
      "],",
      "},",
      "};",
      "fallback",
      "minecraft:item/fallback,",
      "} with {",
      "transformation: { translation: [0, 0, 0] },",
      "}",
      "}"
    ].join("\n");

    const formatted = formatRsglText(source);

    assert.strictEqual(formatted, [
      "item recursive {",
      "  first_match {",
      "    when property minecraft:component predicate \"enchantments\" value [",
      "      { enchantments: minecraft:channeling }",
      "    ] =>",
      "    condition property minecraft:using_item {",
      "      on_true",
      "      empty {}",
      "      on_false selected_item {},",
      "    } with {",
      "      transformation: {",
      "        scale: [",
      "          1,",
      "          1,",
      "          1,",
      "        ],",
      "      },",
      "    };",
      "    fallback",
      "    minecraft:item/fallback,",
      "  } with {",
      "    transformation: { translation: [0, 0, 0] },",
      "  }",
      "}"
    ].join("\n"));
    assert.ok(formatted.includes("    } with {"), "postfix options must stay on the closing-brace line");
    assert.ok(formatted.includes("      empty {}"), "canonical empty nodes must stay compact");
    assert.strictEqual(formatRsglText(formatted), formatted);
  });

  it("aligns an arrow-newline RHS after a multiline selector with the owner body", () => {
    const source = [
      "item display {",
      "select property minecraft:display_context {",
      "case [",
      "\"gui\",",
      "\"ground\";",
      "] =>",
      "composite {",
      "model minecraft:item/base;",
      "model minecraft:item/overlay,",
      "}",
      "fallback empty {}",
      "}",
      "}"
    ].join("\n");

    const formatted = formatRsglText(source);

    assert.strictEqual(formatted, [
      "item display {",
      "  select property minecraft:display_context {",
      "    case [",
      "      \"gui\",",
      "      \"ground\";",
      "    ] =>",
      "    composite {",
      "      model minecraft:item/base;",
      "      model minecraft:item/overlay,",
      "    }",
      "    fallback empty {}",
      "  }",
      "}"
    ].join("\n"));
    assert.strictEqual(formatRsglText(formatted), formatted);
  });

  it("keeps list and object spread markers attached to their operands", () => {
    const formatted = formatRsglText([
      "let combined = [",
      "head",
      "...middle",
      "tail",
      "]",
      "let derived = {",
      "...base",
      "particle: texture",
      "}"
    ].join("\n"));

    assert.strictEqual(formatted, [
      "let combined = [",
      "  head",
      "  ...middle",
      "  tail",
      "]",
      "let derived = {",
      "  ...base",
      "  particle: texture",
      "}"
    ].join("\n"));
    assert.strictEqual(formatRsglText(formatted), formatted);
  });

  it("keeps namespace imports intact and idempotent", () => {
    const source = [
      "  import * as common from \"./common.rsgl\"  ",
      "let stone = common.STONE"
    ].join("\n");
    const formatted = formatRsglText(source);

    assert.strictEqual(formatted, [
      "import * as common from \"./common.rsgl\"",
      "let stone = common.STONE"
    ].join("\n"));
    assert.strictEqual(formatRsglText(formatted), formatted);
  });

});
