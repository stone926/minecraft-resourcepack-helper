import * as assert from "node:assert";
import {
  blockRsglCompletions,
  getRsglCompletionCandidates
} from "../../src/completionData";
import { rsglModelGeometryCompletionDescriptors } from "../../src/modelGeometrySyntax";

describe("RSGL completion data", () => {
  it("provides top-level and block-aware completion candidates", () => {
    const topLevel = getRsglCompletionCandidates("", 0);
    assert.ok(topLevel.some(candidate => candidate.label === "target"));
    assert.ok(topLevel.some(candidate => candidate.label === "target mc"));
    assert.ok(topLevel.some(candidate => candidate.label === "export"));
    assert.ok(topLevel.some(candidate => candidate.label === "atlas"));
    assert.ok(topLevel.some(candidate => candidate.label === "particles"));
    assert.ok(topLevel.some(candidate => candidate.label === "equipment"));
    assert.ok(topLevel.some(candidate => candidate.label === "font"));
    assert.ok(topLevel.some(candidate => candidate.label === "waypoint_style"));
    assert.ok(topLevel.some(candidate => candidate.label === "post_effect"));
    assert.ok(topLevel.some(candidate => candidate.label === "blockstate variants"));
    assert.ok(topLevel.some(candidate => candidate.label === "blockstate multipart"));
    assert.strictEqual(topLevel.some(candidate => candidate.label === "blockstate"), false);
    assert.ok(topLevel.some(candidate => candidate.label === "json"));
    assert.ok(topLevel.some(candidate => candidate.label === "lang"));
    assert.ok(topLevel.some(candidate => candidate.label === "sounds"));
    assert.ok(topLevel.some(candidate => candidate.label === "text"));
    assert.ok(topLevel.some(candidate => candidate.label === "copy"));
    assert.ok(topLevel.some(candidate => candidate.label === "extern model"));
    assert.ok(topLevel.some(candidate => candidate.label === "model block impl"));
    assert.ok(topLevel.some(candidate => candidate.label === "template resources"));
    assert.ok(topLevel.some(candidate => candidate.label === "template -> model"));
    assert.ok(topLevel.some(candidate => candidate.label === "template -> variants"));
    assert.ok(topLevel.some(candidate => candidate.label === "template -> multipart"));
    assert.strictEqual(topLevel.some(candidate => candidate.label === "template"), false);
    assert.strictEqual(topLevel.some(candidate => candidate.label === "fragment" || candidate.label === "fn"), false);
    assert.strictEqual(topLevel.some(candidate => candidate.label === "cubeAll"), false);
    for (const label of [
      "map",
      "filter",
      "flatMap",
      "concat",
      "join",
      "entries",
      "keys",
      "values",
      "mergeObjects",
      "has"
    ]) {
      assert.ok(topLevel.some(candidate => candidate.label === label), `missing ${label} completion`);
    }

    const inBlock = getRsglCompletionCandidates("model block stone {\n  ", "model block stone {\n  ".length);
    assert.ok(inBlock.some(candidate => candidate.label === "textures"));
    assert.ok(inBlock.some(candidate => candidate.label === "box"));
    assert.ok(inBlock.some(candidate => candidate.label === "element"));
    assert.ok(inBlock.some(candidate => candidate.label === "base"));
    assert.ok(inBlock.some(candidate => candidate.label === "merge"));
    assert.ok(inBlock.some(candidate => candidate.label === "merge deep"));
    assert.ok(inBlock.some(candidate => candidate.label === "merge strict"));
    assert.ok(inBlock.some(candidate => candidate.label === "merge upsert"));
    assert.ok(inBlock.some(candidate => candidate.label === "merge append"));
    assert.strictEqual(inBlock.some(candidate => candidate.label === "raw_json"), false);
    assert.strictEqual(inBlock.some(candidate => candidate.label === "raw_json_file"), false);
    assert.ok(inBlock.some(candidate => candidate.label === "for multidim"));
  });

  it("filters explicit template body completions by output dialect", () => {
    const labelsAtEnd = (text: string) => new Set(
      getRsglCompletionCandidates(text, text.length).map(candidate => candidate.label)
    );
    const model = labelsAtEnd("template geometry() -> model {\n  ");
    assert.ok(model.has("element"));
    assert.ok(model.has("textures"));
    assert.strictEqual(model.has("variants"), false);
    assert.strictEqual(model.has("extern var"), false);
    assert.strictEqual(model.has("base"), false);

    const variants = labelsAtEnd("template states() -> variants {\n  ");
    assert.ok(variants.has("use"));
    assert.ok(variants.has("for"));
    assert.ok(variants.has("variant entry"));
    assert.ok(variants.has("random"));
    assert.strictEqual(variants.has("element"), false);
    assert.strictEqual(variants.has("multipart"), false);

    const multipart = labelsAtEnd("template parts() -> multipart {\n  ");
    assert.ok(multipart.has("apply"));
    assert.ok(multipart.has("when"));
    assert.ok(multipart.has("random"));
  });

  it("retains explicit template completion dialects inside nested control flow", () => {
    const labelsAtEnd = (text: string) => new Set(
      getRsglCompletionCandidates(text, text.length).map(candidate => candidate.label)
    );
    const nestedModel = labelsAtEnd([
      "template geometry() -> model {",
      "  for part in [top] {",
      "    if true {",
      "      "
    ].join("\n"));
    assert.ok(nestedModel.has("element"));
    assert.strictEqual(nestedModel.has("range"), false);
    assert.strictEqual(nestedModel.has("variants"), false);

    const nestedVariants = labelsAtEnd([
      "template states() -> variants {",
      "  for state in [off, on] {",
      "    if true {",
      "      "
    ].join("\n"));
    assert.ok(nestedVariants.has("variant entry"));
    assert.strictEqual(nestedVariants.has("element"), false);
    assert.strictEqual(nestedVariants.has("apply"), false);
  });

  it("keeps model geometry completion metadata and ordering descriptor-backed", () => {
    const geometryLabels = new Set(
      rsglModelGeometryCompletionDescriptors.map(descriptor => descriptor.label)
    );
    const geometryCandidates = blockRsglCompletions.filter(candidate =>
      geometryLabels.has(candidate.label)
    );

    assert.deepStrictEqual(
      geometryCandidates,
      rsglModelGeometryCompletionDescriptors.map(descriptor => ({
        ...descriptor,
        kind: "snippet"
      }))
    );
  });

  it("offers base only at the first position of a concrete resource root", () => {
    const labelsAtEnd = (text: string) => new Set(
      getRsglCompletionCandidates(text, text.length).map(candidate => candidate.label)
    );

    assert.ok(labelsAtEnd("model block stone {\n  ").has("base"));
    assert.ok(labelsAtEnd("model block stone {\n  // imported model\n  ba").has("base"));
    assert.ok(labelsAtEnd("for id in [stone] {\n  model block id {\n    ").has("base"));

    const afterStatement = labelsAtEnd([
      "model block stone {",
      "  parent minecraft:block/cube_all",
      "  "
    ].join("\n"));
    assert.strictEqual(afterStatement.has("base"), false);
    assert.ok(afterStatement.has("merge"));
    assert.ok(afterStatement.has("merge deep"));

    const nestedSection = labelsAtEnd([
      "model block stone {",
      "  textures {",
      "    "
    ].join("\n"));
    assert.strictEqual(nestedSection.has("base"), false);
    assert.ok(nestedSection.has("merge upsert"));

    assert.strictEqual(labelsAtEnd("template fragment() {\n  ").has("base"), false);
    assert.strictEqual(labelsAtEnd("model block stone {\n  b\n  ").has("base"), false);
  });
});
