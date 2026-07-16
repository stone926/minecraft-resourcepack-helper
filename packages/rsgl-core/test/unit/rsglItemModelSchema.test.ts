import * as assert from "node:assert";
import {
  ITEM_MODEL_TRANSFORMATION_INTRODUCED_FORMAT,
  compareItemModelFormats,
  findItemModelSpecialSchema,
  isItemModelSchemaEntryAvailable,
  itemModelHistoricalFormats,
  itemModelNodeSchemas,
  itemModelPropertyOptionVocabulary,
  itemModelPropertySchemas,
  itemModelRootFields,
  itemModelSpecialSchemas,
  itemModelSpecialVariantsForTarget,
  projectItemModelSchemaVariants,
  type ItemModelFormat
} from "../../src/itemModelSchema";

describe("RSGL item model schema registry", () => {
  it("compares and projects pack-format tuples without decimal coercion", () => {
    assert.ok(compareItemModelFormats([65, 1], [65, 2]) < 0);
    assert.ok(compareItemModelFormats([65, 2], [65, 10]) < 0);
    assert.ok(compareItemModelFormats([66, 0], [65, 99]) > 0);

    const variants = [
      { introduced: [65, 1] as const, value: "before" },
      { introduced: [65, 2] as const, value: "after" }
    ];
    assert.deepStrictEqual(projectItemModelSchemaVariants(variants, [65, 1]), ["before"]);
    assert.deepStrictEqual(projectItemModelSchemaVariants(variants, [65, 2]), ["after"]);
    assert.deepStrictEqual(projectItemModelSchemaVariants(variants, undefined), ["before", "after"]);
  });

  it("keeps parser-facing property options target-neutral", () => {
    const rangeOptions = itemModelPropertyOptionVocabulary.range_dispatch as readonly string[];
    const selectOptions = itemModelPropertyOptionVocabulary.select as readonly string[];
    const conditionOptions = itemModelPropertyOptionVocabulary.condition as readonly string[];
    assert.ok(rangeOptions.includes("scale"));
    assert.ok(rangeOptions.includes("remaining"));
    assert.ok(rangeOptions.includes("natural_only"));
    assert.ok(!rangeOptions.includes("component"));
    assert.ok(selectOptions.includes("component"));
    assert.ok(conditionOptions.includes("value"));
  });

  it("projects special field events independently from subtype lifecycles", () => {
    const shulker = findItemModelSpecialSchema("shulker_box");
    assert.ok(shulker);
    const fieldsAt82 = itemModelSpecialVariantsForTarget(shulker, [82, 0])[0].fields;
    const fieldsAt83 = itemModelSpecialVariantsForTarget(shulker, [83, 0])[0].fields;
    const unionFields = itemModelSpecialVariantsForTarget(shulker, undefined)
      .flatMap(variant => variant.fields);

    assert.ok(fieldsAt82.some(field => field.name === "orientation"));
    assert.ok(!fieldsAt83.some(field => field.name === "orientation"));
    assert.ok(unionFields.some(field => field.name === "orientation"));
    assert.ok(isItemModelSchemaEntryAvailable(findItemModelSpecialSchema("bed")!, undefined));
    assert.ok(!isItemModelSchemaEntryAvailable(findItemModelSpecialSchema("bed")!, [86, 0]));
  });

  it("derives whole-shape history representatives from registry events", () => {
    const formats = itemModelHistoricalFormats();
    assert.deepStrictEqual(
      formats,
      [...formats].sort(compareItemModelFormats)
    );
    assert.strictEqual(new Set(formats.map(format => format.join("."))).size, formats.length);
    for (const transition of ["44.0", "46.0", "65.2", "83.0", "86.0", "87.0"]) {
      assert.ok(formats.some(format => format.join(".") === transition), transition);
    }
  });

  it("covers the complete design target matrix", () => {
    const snapshot = (target: ItemModelFormat): string => {
      const roots = itemModelRootFields
        .filter(field => isItemModelSchemaEntryAvailable(field, target))
        .map(field => field.name)
        .sort();
      const properties = Object.entries(itemModelPropertySchemas)
        .flatMap(([family, schema]) => schema.properties
          .filter(property => isItemModelSchemaEntryAvailable(property, target))
          .map(property => family + ":" + property.name))
        .sort();
      const specials = itemModelSpecialSchemas
        .filter(special => isItemModelSchemaEntryAvailable(special, target))
        .map(special => special.name)
        .sort();
      const shulker = findItemModelSpecialSchema("shulker_box")!;
      const shulkerFields = itemModelSpecialVariantsForTarget(shulker, target)
        .flatMap(variant => variant.fields.map(field => field.name))
        .sort();
      const nodes = itemModelNodeSchemas
        .filter(node => isItemModelSchemaEntryAvailable(node, target))
        .map(node => node.name)
        .sort();
      const transformation = compareItemModelFormats(
        target,
        ITEM_MODEL_TRANSFORMATION_INTRODUCED_FORMAT
      ) >= 0;
      return JSON.stringify({ roots, properties, specials, shulkerFields, nodes, transformation });
    };

    const matrix: Array<[ItemModelFormat, ItemModelFormat, boolean]> = [
      [[43, 0], [44, 0], true],
      [[47, 0], [48, 0], true],
      [[48, 0], [49, 0], true],
      [[62, 0], [63, 0], true],
      [[69, 0], [70, 0], true],
      [[74, 0], [75, 0], false],
      [[82, 0], [83, 0], true],
      [[83, 0], [84, 0], true],
      [[85, 0], [86, 0], true],
      [[86, 0], [87, 0], true],
      [[87, 0], [88, 0], false]
    ];
    for (const [before, after, changes] of matrix) {
      assert.strictEqual(
        snapshot(before) !== snapshot(after),
        changes,
        "Unexpected schema transition at " + before.join(".") + " -> " + after.join(".")
      );
    }
  });
});
