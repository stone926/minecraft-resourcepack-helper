import * as assert from "node:assert";
import * as path from "node:path";
import { createCitTemplate, generateCitForResource } from "../../commands/citTemplate";

describe("CIT template commands", () => {
  it("creates type-specific CIT templates", () => {
    assert.match(createCitTemplate("item", "minecraft:stick"), /type=item\nitems=minecraft:stick\ntexture=/);
    assert.match(createCitTemplate("armor", "minecraft:diamond_helmet"), /type=armor\nitems=minecraft:diamond_helmet\ntexture\.layer_1=/);
    assert.match(createCitTemplate("elytra"), /type=elytra\ntexture=/);
    assert.match(createCitTemplate("enchantment"), /type=enchantment\ntexture=.*\nblend=add/);
  });

  it("generates CIT properties for item model resources", () => {
    const generated = generateCitForResource(path.join(
      "pack",
      "assets",
      "minecraft",
      "models",
      "item",
      "custom_sword.json"
    ));

    assert.strictEqual(generated?.fileName, path.join("pack", "assets", "minecraft", "citresewn", "cit", "custom_sword.properties"));
    assert.strictEqual(generated?.text, [
      "type=item",
      "items=minecraft:custom_sword",
      "model=minecraft:item/custom_sword",
      ""
    ].join("\n"));
  });

  it("generates CIT properties for item texture resources", () => {
    const generated = generateCitForResource(path.join(
      "pack",
      "assets",
      "custom",
      "textures",
      "item",
      "wand.png"
    ));

    assert.strictEqual(generated?.fileName, path.join("pack", "assets", "custom", "citresewn", "cit", "wand.properties"));
    assert.strictEqual(generated?.text, [
      "type=item",
      "items=custom:wand",
      "texture=custom:item/wand",
      ""
    ].join("\n"));
  });
});
