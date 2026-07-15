import * as assert from "node:assert";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule } from "../../src/semantic";

describe("RSGL blockstate object spread semantics", () => {
  it("accepts object-union spreads in case selectors", () => {
    assert.deepStrictEqual(diagnosticCodes([
      "let selector = true ? { facing: \"north\" } : { powered: true }",
      "blockstate variants minecraft:test {",
      "  case { ...selector } => minecraft:block/stone",
      "}"
    ]), []);
  });

  it("accepts conditional StatePredicate values without exposing condition-object spreads", () => {
    assert.deepStrictEqual(diagnosticCodes([
      "let facing: StatePredicate = $state.facing == north",
      "let powered: StatePredicate = $state.powered == true",
      "let condition = true ? facing : powered",
      "blockstate multipart minecraft:test {",
      "  part when condition => minecraft:block/stone",
      "}"
    ]), []);

    assert.deepStrictEqual(diagnosticCodes([
      "let condition = true ? { OR: [{ facing: \"north\" }] } : { powered: true }",
      "blockstate multipart minecraft:test {",
      "  part when { ...condition } => minecraft:block/stone",
      "}"
    ]), ["rsgl.invalidBlockstatePredicate"]);
  });

  it("rejects spreads in closed ModelSpec with blocks", () => {
    assert.deepStrictEqual(diagnosticCodes([
      "let options = true ? { x: 0 } : { y: 90 }",
      "blockstate variants minecraft:test {",
      "  case * => minecraft:block/stone with { ...options }",
      "}"
    ]), ["rsgl.invalidBlockstateModelOptionsSpread"]);
  });

  it("keeps rejecting a selector spread union with a non-object arm", () => {
    assert.deepStrictEqual(diagnosticCodes([
      "let invalid = true ? { facing: \"north\" } : 1",
      "blockstate variants minecraft:test {",
      "  case { ...invalid } => minecraft:block/stone",
      "}"
    ]), ["rsgl.invalidObjectSpread"]);
  });
});

function diagnosticCodes(lines: readonly string[]): string[] {
  const module = parseRsgl(lines.join("\n"));
  assert.deepStrictEqual(module.diagnostics, []);
  return bindRsglModule(module).diagnostics.map(diagnostic => diagnostic.code);
}
