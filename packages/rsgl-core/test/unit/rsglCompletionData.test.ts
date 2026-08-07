import * as assert from "node:assert";
import {
  blockRsglCompletions,
  getRsglCompletionCandidates
} from "../../src/completionData";
import { rsglModelGeometryCompletionDescriptors } from "../../src/modelGeometrySyntax";

describe("RSGL completion data", () => {
  it("inserts mapping and output-contract arrows according to their roles", () => {
    const candidates = [
      ...getRsglCompletionCandidates("", 0),
      ...blockRsglCompletions
    ];

    for (const label of ["select", "lambda", "seq", "map", "filter", "flatMap"]) {
      const candidate = candidates.find(item => item.label === label);
      const insertText = candidate?.insertText;
      assert.ok(insertText, `missing ${label} completion`);
      assert.ok(insertText.includes("=>"), `${label} should insert a mapping arrow`);
      assert.strictEqual(insertText.includes(" -> "), false, `${label} must not insert an output-contract arrow`);
    }

    for (const label of ["template -> model", "template -> variants", "template -> multipart", "template -> choice", "template -> item_model"]) {
      const candidate = candidates.find(item => item.label === label);
      assert.ok(candidate?.insertText?.includes(" -> "), `${label} should insert an output-contract arrow`);
    }
  });

  it("inserts canonical bodies for item terminal models", () => {
    assert.strictEqual(
      blockRsglCompletions.find(candidate => candidate.label === "empty")?.insertText,
      "empty {}"
    );
    assert.strictEqual(
      blockRsglCompletions.find(candidate => candidate.label === "selected_item")?.insertText,
      "selected_item {}"
    );
  });

  it("provides top-level and block-aware completion candidates", () => {
    const topLevel = getRsglCompletionCandidates("", 0);
    assert.ok(topLevel.some(candidate => candidate.label === "target"));
    assert.ok(topLevel.some(candidate => candidate.label === "target mc"));
    assert.ok(topLevel.some(candidate => candidate.label === "export"));
    assert.deepStrictEqual(
      topLevel.find(candidate => candidate.label === "import namespace"),
      {
        label: "import namespace",
        insertText: "import * as ${1:common} from \"${2:./module.rsgl}\"",
        detail: "Import an RSGL module as a namespace",
        kind: "snippet"
      }
    );
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
    assert.ok(topLevel.some(candidate => candidate.label === "template -> choice"));
    assert.ok(topLevel.some(candidate => candidate.label === "template -> item_model"));
    assert.strictEqual(topLevel.some(candidate => candidate.label === "template"), false);
    for (const label of [
      "asList",
      "length",
      "map",
      "filter",
      "flat",
      "flatMap",
      "concat",
      "join",
      "entries",
      "keys",
      "values",
      "mergeObjects",
      "product",
      "has"
    ]) {
      assert.ok(topLevel.some(candidate => candidate.label === label), `missing ${label} completion`);
    }

    const inBlock = getRsglCompletionCandidates("model block stone {\n  ", "model block stone {\n  ".length);
    assert.ok(inBlock.some(candidate => candidate.label === "textures"));
    assert.ok(inBlock.some(candidate => candidate.label === "box"));
    assert.ok(inBlock.some(candidate => candidate.label === "element"));
    assert.ok(inBlock.some(candidate => candidate.label === "transform"));
    assert.ok(inBlock.some(candidate => candidate.label === "base"));
    assert.ok(inBlock.some(candidate => candidate.label === "merge"));
    assert.ok(inBlock.some(candidate => candidate.label === "merge deep"));
    assert.ok(inBlock.some(candidate => candidate.label === "merge strict"));
    assert.ok(inBlock.some(candidate => candidate.label === "merge upsert"));
    assert.ok(inBlock.some(candidate => candidate.label === "merge append"));
    assert.deepStrictEqual(
      inBlock.find(candidate => candidate.label === "computed property"),
      {
        label: "computed property",
        insertText: "[${1:key}]: ${2:value}",
        detail: "Resource property with a computed key",
        kind: "property"
      }
    );
    assert.deepStrictEqual(
      inBlock.find(candidate => candidate.label === "for object"),
      {
        label: "for object",
        insertText: "for { ${1:name}, ${2:value}: ${3:localValue} } in ${4:items} {\n  ${5}\n}",
        detail: "Finite expansion loop with named object bindings",
        kind: "snippet"
      }
    );
    assert.ok(inBlock.some(candidate => candidate.label === "for multidim"));
    assert.deepStrictEqual(
      inBlock.find(candidate => candidate.label === "for indexed"),
      {
        label: "for indexed",
        insertText: "for ${1:item} at ${2:index} in ${3:items} {\n  ${4}\n}",
        detail: "Finite expansion loop with a zero-based index",
        kind: "snippet"
      }
    );
  });

  it("filters explicit template body completions by output dialect", () => {
    const labelsAtEnd = (text: string) => new Set(
      getRsglCompletionCandidates(text, text.length).map(candidate => candidate.label)
    );
    const model = labelsAtEnd("template geometry() -> model {\n  ");
    assert.ok(model.has("element"));
    assert.ok(model.has("transform"));
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
    assert.strictEqual(variants.has("transform"), false);
    assert.strictEqual(variants.has("multipart"), false);

    const multipart = labelsAtEnd("template parts() -> multipart {\n  ");
    assert.ok(multipart.has("part always"));
    assert.ok(multipart.has("part when"));
    assert.ok(multipart.has("random"));

    const choice = labelsAtEnd("template options() -> choice {\n  ");
    assert.ok(choice.has("option"));
    assert.ok(choice.has("weighted option"));
    assert.ok(choice.has("for"));
    assert.strictEqual(choice.has("variant entry"), false);
    assert.strictEqual(choice.has("part always"), false);
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
    assert.ok(nestedModel.has("transform"));
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
    assert.strictEqual(nestedVariants.has("transform"), false);
    assert.strictEqual(nestedVariants.has("part always"), false);
  });

  it("scopes item-model completions to roots, typed owners, values, and options", () => {
    const labelsAtEnd = (text: string) => new Set(
      getRsglCompletionCandidates(text, text.length).map(candidate => candidate.label)
    );

    const root = labelsAtEnd("item example {\n  ");
    for (const label of ["model", "select", "range", "condition", "first_match", "use item_model", "for indexed", "for object", "merge", "hand_animation_on_swap"]) {
      assert.ok(root.has(label), `missing item-root completion ${label}`);
    }
    assert.deepStrictEqual(
      getRsglCompletionCandidates("item example {\n  ", "item example {\n  ".length)
        .find(candidate => candidate.label === "for object"),
      {
        label: "for object",
        insertText: "for { ${1:name}, ${2:value}: ${3:localValue} } in ${4:items} {\n  ${5}\n}",
        detail: "Finite item-model expansion with named object bindings",
        kind: "snippet"
      }
    );
    assert.strictEqual(root.has("parent"), false);
    assert.strictEqual(root.has("element"), false);

    const template = labelsAtEnd("template reusable() -> item_model {\n  ");
    assert.ok(template.has("model"));
    assert.ok(template.has("first_match"));
    assert.ok(template.has("use item_model"));
    assert.strictEqual(template.has("merge"), false);
    assert.strictEqual(template.has("hand_animation_on_swap"), false);

    const select = labelsAtEnd([
      "item example {",
      "  select property minecraft:display_context {",
      "    "
    ].join("\n"));
    assert.ok(select.has("case"));
    assert.ok(select.has("fallback"));
    assert.ok(select.has("for"));
    assert.ok(select.has("for indexed"));
    assert.ok(select.has("for object"));
    assert.strictEqual(select.has("entry"), false);

    const range = labelsAtEnd([
      "item example {",
      "  range property minecraft:damage {",
      "    "
    ].join("\n"));
    assert.ok(range.has("entry"));
    assert.ok(range.has("frames"));
    assert.strictEqual(range.has("case"), false);

    const nestedValue = labelsAtEnd([
      "item example {",
      "  select property minecraft:display_context {",
      "    case \"gui\" => "
    ].join("\n"));
    assert.ok(nestedValue.has("condition"));
    assert.ok(nestedValue.has("empty"));
    assert.ok(nestedValue.has("use item_model"));
    assert.strictEqual(nestedValue.has("case"), false);

    const condition = labelsAtEnd([
      "item example {",
      "  condition property minecraft:using_item {",
      "    "
    ].join("\n"));
    assert.deepStrictEqual(
      [...condition].filter(label => label === "on_true" || label === "on_false").sort(),
      ["on_false", "on_true"]
    );
    for (const control of ["let", "for", "for object", "if"]) {
      assert.strictEqual(condition.has(control), false, `condition must not suggest ${control}`);
    }

    const leafOptions = labelsAtEnd([
      "item example {",
      "  model minecraft:item/example with {",
      "    "
    ].join("\n"));
    assert.deepStrictEqual([...leafOptions].sort(), ["tints", "transformation"]);

    const transformOptions = labelsAtEnd([
      "item example {",
      "  composite { model minecraft:item/example } with {",
      "    "
    ].join("\n"));
    assert.deepStrictEqual([...transformOptions], ["transformation"]);

    const modelBody = labelsAtEnd("model block example {\n  ");
    assert.strictEqual(modelBody.has("range"), false);
    assert.strictEqual(modelBody.has("select"), false);
  });

  it("derives target-aware item property, enum, tint, special, and transform candidates from the schema", () => {
    const labelsAtEnd = (text: string) => new Set(
      getRsglCompletionCandidates(text, text.length).map(candidate => candidate.label)
    );

    const format44Properties = labelsAtEnd("target java format [44, 0]\nitem x {\n  select property ");
    assert.ok(format44Properties.has("minecraft:display_context"));
    assert.ok(format44Properties.has("minecraft:potion_contents"));
    assert.strictEqual(format44Properties.has("minecraft:component"), false);
    assert.strictEqual(format44Properties.has("minecraft:context_dimension"), false);

    const format44Root = labelsAtEnd("target java format [44, 0]\nitem x {\n  ");
    const format44Branch = labelsAtEnd([
      "target java format [44, 0]",
      "item x {",
      "  select property minecraft:display_context {",
      "    fallback "
    ].join("\n"));
    assert.strictEqual(format44Root.has("empty"), false);
    assert.strictEqual(format44Branch.has("empty"), false);
    const format46Root = labelsAtEnd("target java format [46, 0]\nitem x {\n  ");
    assert.ok(format46Root.has("empty"));

    const minecraftVersionOptions = labelsAtEnd([
      "target java mc \"1.21.4\"",
      "item x {",
      "  range property minecraft:time "
    ].join("\n"));
    assert.ok(minecraftVersionOptions.has("source"), "1.21.4 maps to format 46");
    assert.strictEqual(minecraftVersionOptions.has("natural_only"), false);

    const sourceValues = labelsAtEnd([
      "target java format [46, 0]",
      "item x {",
      "  range property minecraft:time source "
    ].join("\n"));
    assert.deepStrictEqual([...sourceValues].sort(), ["daytime", "moon_phase", "random"]);

    const displayContext65_1 = labelsAtEnd([
      "target java format [65, 1]",
      "item x {",
      "  select property minecraft:display_context {",
      "    case "
    ].join("\n"));
    assert.ok(displayContext65_1.has("\"none\""));
    assert.strictEqual(displayContext65_1.has("\"on_shelf\""), false);
    const displayContext65_2 = labelsAtEnd([
      "target java format [65, 2]",
      "item x {",
      "  select property minecraft:display_context {",
      "    case "
    ].join("\n"));
    assert.ok(displayContext65_2.has("\"on_shelf\""));

    const shulker82 = labelsAtEnd([
      "target java format [82, 0]",
      "item x {",
      "  special base minecraft:item/x model { type: minecraft:shulker_box, "
    ].join("\n"));
    assert.ok(shulker82.has("orientation"));
    const shulker83 = labelsAtEnd([
      "target java format [83, 0]",
      "item x {",
      "  special base minecraft:item/x model { type: minecraft:shulker_box, "
    ].join("\n"));
    assert.strictEqual(shulker83.has("orientation"), false);
    assert.ok(shulker83.has("texture"));

    const tintType = labelsAtEnd("item x {\n  model minecraft:item/x with { tints: [{ type: ");
    assert.ok(tintType.has("minecraft:potion"));
    const tintFields = labelsAtEnd("item x {\n  model minecraft:item/x with { tints: [{ type: minecraft:potion, ");
    assert.deepStrictEqual([...tintFields], ["default"]);

    const oldLeafOptions = labelsAtEnd("target java format [44, 0]\nitem x {\n  model minecraft:item/x with { ");
    assert.deepStrictEqual([...oldLeafOptions], ["tints"]);
    const transformationFields = labelsAtEnd([
      "target java format [83, 0]",
      "item x {",
      "  model minecraft:item/x with { transformation: { "
    ].join("\n"));
    assert.deepStrictEqual(
      [...transformationFields],
      ["right_rotation", "translation", "left_rotation", "scale"]
    );
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

  it("keeps model completions inside nested transform bodies", () => {
    const text = [
      "template geometry() -> model {",
      "  transform rotate_y(90) around [8, 8, 8] {",
      "    "
    ].join("\n");
    const candidates = getRsglCompletionCandidates(text, text.length);
    const transform = candidates.find(candidate => candidate.label === "transform");

    assert.ok(candidates.some(candidate => candidate.label === "element"));
    assert.ok(transform?.insertText);
    assert.ok(transform.insertText.includes("rotate_x,rotate_y,rotate_z"));
    assert.ok(transform.insertText.includes("around ["));
    assert.strictEqual(candidates.some(candidate => candidate.label === "range"), false);
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
