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
});

function getMessages(text: string, fileName = path.join("pack", "assets", "minecraft", "citresewn", "cit", "sword.properties")): string[] {
  const document: CitLanguageDocument = {
    fileName,
    getText: () => text
  };
  return getCitDiagnostics(document, { locale: "en" }).map(diagnostic => diagnostic.message);
}
