import * as assert from "node:assert";
import * as path from "node:path";
import { getCitDiagnostics } from "../../diagnostics/citDiagnosticsCore";
import type { CitLanguageDocument } from "../../utils/citLanguage";

describe("CIT diagnostics", () => {
  it("reports unknown keys and invalid values", () => {
    const diagnostics = getMessages([
      "type=wrong",
      "unknownKey=value",
      "stackSize=zero"
    ].join("\n"));

    assert.ok(diagnostics.some(message => message.includes("Invalid value 'wrong'")));
    assert.ok(diagnostics.some(message => message.includes("Unknown CIT key 'unknownKey'")));
    assert.ok(diagnostics.some(message => message.includes("Invalid range value 'zero'")));
  });

  it("reports duplicate singleton keys and type-filtered keys", () => {
    const diagnostics = getMessages([
      "type=armor",
      "type=item",
      "model=custom:item/sword"
    ].join("\n"));

    assert.ok(diagnostics.some(message => message.includes("Duplicate CIT key 'type'")));
    assert.ok(diagnostics.some(message => message.includes("not valid for type 'armor'")));
  });

  it("recognizes global cit.properties keys separately", () => {
    const globalFile = path.join("pack", "assets", "minecraft", "citresewn", "cit.properties");
    const diagnostics = getMessages("type=item\nmethod=cycle", globalFile);

    assert.ok(diagnostics.some(message => message.includes("not valid in global cit.properties")));
    assert.strictEqual(diagnostics.some(message => message.includes("method")), false);
  });

  it("validates boolean, number, and regex formats", () => {
    const diagnostics = getMessages([
      "type=enchantment",
      "blur=yes",
      "duration=-1",
      "nbt.display.Name=regex:("
    ].join("\n"));

    assert.ok(diagnostics.some(message => message.includes("Invalid boolean value 'yes'")));
    assert.ok(diagnostics.some(message => message.includes("Value must be at least 0")));
    assert.ok(diagnostics.some(message => message.includes("Invalid regular expression")));
  });

  it("validates item and enchantment ids", () => {
    const diagnostics = getMessages([
      "items=minecraft:missing",
      "enchantments=missing_enchantment"
    ].join("\n"), undefined, {
      items: ["minecraft:stick"],
      enchantments: ["minecraft:sharpness"]
    });

    assert.ok(diagnostics.some(message => message.includes("Unknown item id 'minecraft:missing'")));
    assert.ok(diagnostics.some(message => message.includes("Unknown enchantment id 'minecraft:missing_enchantment'")));
  });

  it("allows type=item to infer items from a valid file name", () => {
    const fileName = path.join("pack", "assets", "minecraft", "citresewn", "cit", "stick.properties");
    const diagnostics = getMessages("type=item", fileName, {
      items: ["minecraft:stick"],
      enchantments: []
    });

    assert.strictEqual(diagnostics.some(message => message.includes("requires items")), false);
  });

  it("reports type=item without items or valid file name", () => {
    const diagnostics = getMessages("type=item", undefined, {
      items: ["minecraft:stick"],
      enchantments: []
    });

    assert.ok(diagnostics.some(message => message.includes("requires items")));
  });

  it("reports elytra redundant items and missing texture", () => {
    const diagnostics = getMessages([
      "type=elytra",
      "items=minecraft:elytra"
    ].join("\n"));

    assert.ok(diagnostics.some(message => message.includes("items is ignored for type=elytra")));
    assert.ok(diagnostics.some(message => message.includes("type=elytra should declare texture")));
  });

  it("reports non-armor items for type=armor", () => {
    const diagnostics = getMessages([
      "type=armor",
      "items=stick diamond_helmet"
    ].join("\n"), undefined, {
      items: ["minecraft:stick", "minecraft:diamond_helmet"],
      enchantments: []
    });

    assert.ok(diagnostics.some(message => message.includes("minecraft:stick") && message.includes("not an armor item")));
    assert.strictEqual(diagnostics.some(message => message.includes("minecraft:diamond_helmet") && message.includes("not an armor item")), false);
  });
});

function getMessages(
  text: string,
  fileName = path.join("pack", "assets", "minecraft", "citresewn", "cit", "sword.properties"),
  resourceIds?: { items: string[]; enchantments: string[] }
): string[] {
  const document: CitLanguageDocument = {
    fileName,
    getText: () => text
  };
  return getCitDiagnostics(document, { locale: "en", resourceIds }).map(diagnostic => diagnostic.message);
}
