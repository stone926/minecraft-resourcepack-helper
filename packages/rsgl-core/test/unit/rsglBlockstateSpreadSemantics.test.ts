import * as assert from "node:assert";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule } from "../../src/semantic";

describe("RSGL blockstate object spread semantics", () => {
  it("accepts object-union spreads in variant selectors", () => {
    assert.deepStrictEqual(diagnosticCodes([
      "let selector = true ? { facing: \"north\" } : { powered: true }",
      "blockstate variants minecraft:test {",
      "  { ...selector }: minecraft:block/stone",
      "}"
    ]), []);
  });

  it("checks multipart union arms independently before diagnosing mixed conditions", () => {
    assert.deepStrictEqual(diagnosticCodes([
      "let condition = true ? { OR: [{ facing: \"north\" }] } : { powered: true }",
      "blockstate multipart minecraft:test {",
      "  when { ...condition } apply minecraft:block/stone",
      "}"
    ]), []);

    assert.deepStrictEqual(diagnosticCodes([
      "let condition = true ? { OR: [{ facing: \"north\" }] } : { powered: true }",
      "blockstate multipart minecraft:test {",
      "  when { ...condition, facing: \"north\" } apply minecraft:block/stone",
      "}"
    ]), ["rsgl.mixedBlockstateWhenCondition"]);
  });

  it("accepts model-object union spreads and requires a model on every closed arm", () => {
    assert.deepStrictEqual(diagnosticCodes([
      "let choice = true ? { model: minecraft:block/stone, x: 0 } : { model: minecraft:block/dirt, y: 90 }",
      "blockstate variants minecraft:test {",
      "  {}: { ...choice }",
      "  { powered: true }: { ...{ x: 0 }, model: minecraft:block/stone }",
      "}"
    ]), []);

    assert.deepStrictEqual(diagnosticCodes([
      "let choice = true ? { model: minecraft:block/stone } : { x: 0 }",
      "blockstate variants minecraft:test {",
      "  {}: { ...choice }",
      "}"
    ]), ["rsgl.missingBlockstateModel"]);
  });

  it("keeps rejecting a spread union with a non-object runtime arm", () => {
    assert.deepStrictEqual(diagnosticCodes([
      "let invalid = true ? { facing: \"north\" } : 1",
      "blockstate variants minecraft:test {",
      "  { ...invalid }: minecraft:block/stone",
      "}"
    ]), ["rsgl.invalidObjectSpread"]);
  });
});

function diagnosticCodes(lines: readonly string[]): string[] {
  const module = parseRsgl(lines.join("\n"));
  assert.deepStrictEqual(module.diagnostics, []);
  return bindRsglModule(module).diagnostics.map(diagnostic => diagnostic.code);
}
