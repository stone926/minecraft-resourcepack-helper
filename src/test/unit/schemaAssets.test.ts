import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

interface PackageJson {
  contributes?: {
    jsonValidation?: JsonValidationEntry[];
  };
}

interface JsonValidationEntry {
  url?: string;
}

type JsonObject = Record<string, unknown>;

describe("schema assets", () => {
  it("parses every bundled JSON schema asset", () => {
    for (const file of collectJsonFiles(path.join(process.cwd(), "assets", "linters"))) {
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")), file);
    }
  });

  it("does not use common misspelled JSON Schema keywords", () => {
    const misspelledKeywords = new Set(["miximum"]);
    const findings: string[] = [];

    for (const file of collectJsonFiles(path.join(process.cwd(), "assets", "linters"))) {
      findMisspelledSchemaKeywords(readJsonFile<unknown>(file), path.relative(process.cwd(), file), misspelledKeywords, findings);
    }

    assert.deepStrictEqual(findings, []);
  });

  it("ships every local schema referenced by package.json jsonValidation", () => {
    const packageJson = readJsonFile<PackageJson>(path.join(process.cwd(), "package.json"));
    const validations = packageJson.contributes?.jsonValidation ?? [];
    const localUrls = validations
      .map(validation => validation.url)
      .filter((url): url is string => url !== undefined && url.startsWith("./"));

    assert.ok(localUrls.length > 0, "package.json should contribute local JSON schemas");

    for (const url of localUrls) {
      assert.ok(fs.existsSync(path.join(process.cwd(), url)), url);
    }
  });

  it("applies pack.mcmeta language code length constraints to language keys", () => {
    const schema = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "pack.mcmeta.json"));

    const languagePropertyNames = getObjectAt(schema, ["properties", "language", "propertyNames"]);
    assert.strictEqual(languagePropertyNames.minLength, 1);
    assert.strictEqual(languagePropertyNames.maxLength, 16);

    const languageDefinition = getObjectAt(schema, ["definitions", "language"]);
    assert.strictEqual(languageDefinition.propertyNames, undefined);
  });

  it("allows modern block model element rotation syntax", () => {
    const schema = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "models-block.json"));
    const angle = getObjectAt(schema, ["definitions", "angle"]);

    assert.strictEqual(angle.multipleOf, undefined);
    assert.strictEqual(angle.minimum, undefined);
    assert.strictEqual(angle.maximum, undefined);

    const rotationProperties = getObjectAt(schema, ["definitions", "element", "properties", "rotation", "properties"]);
    for (const axis of ["x", "y", "z"]) {
      const axisRotation = getObjectAt(rotationProperties, [axis]);
      assert.strictEqual(axisRotation.$ref, "#/definitions/angle");
    }

    const tintIndex = getObjectAt(schema, ["definitions", "faceProps", "properties", "tintindex"]);
    assert.strictEqual(tintIndex.minimum, -1);
  });

  it("allows z-axis rotation in blockstate model entries", () => {
    const schema = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "blockstates.json"));

    for (const definition of ["model", "model+weight"]) {
      const zRotation = getObjectAt(schema, ["definitions", definition, "properties", "z"]);
      assert.strictEqual(zRotation.$ref, "#/definitions/degree");
    }
  });

  it("covers current waypoint style distance fields", () => {
    const schema = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "waypoint-style.json"));
    const properties = getObjectAt(schema, ["properties"]);

    for (const distanceField of ["near_distance", "far_distance"]) {
      const field = getObjectAt(properties, [distanceField]);
      assert.strictEqual(field.type, "number");
      assert.strictEqual(field.minimum, 0);
      assert.strictEqual(field.maximum, 60000000);
    }
  });

  it("covers current equipment layer fields and preset layer names", () => {
    const schema = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "equipment.json"));
    const layerProperties = getObjectAt(schema, ["definitions", "layer", "properties"]);
    const usePlayerTexture = getObjectAt(layerProperties, ["use_player_texture"]);
    assert.strictEqual(usePlayerTexture.type, "boolean");

    const presetLayers = getObjectAt(schema, ["properties", "layers", "properties"]);
    for (const layerName of [
      "humanoid",
      "humanoid_leggings",
      "humanoid_baby",
      "wings",
      "wolf_body",
      "horse_body",
      "llama_body",
      "happy_ghast_body",
      "nautilus_body",
      "pig_saddle",
      "strider_saddle",
      "camel_saddle",
      "camel_husk_saddle",
      "horse_saddle",
      "donkey_saddle",
      "mule_saddle",
      "skeleton_horse_saddle",
      "zombie_horse_saddle",
      "nautilus_saddle"
    ]) {
      const layer = getObjectAt(presetLayers, [layerName]);
      assert.strictEqual(layer.$ref, "#/definitions/layerList");
    }
  });

  it("covers current PNG texture metadata enum values", () => {
    const schema = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "png.mcmeta.json"));

    const mipmapStrategy = getObjectAt(schema, ["properties", "texture", "properties", "mipmap_strategy"]);
    assert.deepStrictEqual(mipmapStrategy.enum, ["auto", "mean", "dark_cutout", "cutout", "strict_cutout"]);

    const villagerHat = getObjectAt(schema, ["properties", "villager", "properties", "hat"]);
    assert.deepStrictEqual(villagerHat.enum, ["none", "partial", "full"]);

    const legacyVillagerSchema = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "villager.mcmeta.json"));
    const legacyVillagerHat = getObjectAt(legacyVillagerSchema, ["properties", "villager", "properties", "hat"]);
    assert.deepStrictEqual(legacyVillagerHat.enum, ["none", "partial", "full"]);
  });

  it("covers current post effect target and input fields", () => {
    const schema = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "post-effect.json"));

    const targetProperties = getObjectAt(schema, ["definitions", "target", "properties"]);
    for (const property of ["width", "height", "persistent", "clear_color"]) {
      assert.ok(Object.hasOwn(targetProperties, property), `target.${property}`);
    }

    const inputProperties = getObjectAt(schema, ["definitions", "input", "properties"]);
    for (const property of ["sampler_name", "target", "use_depth_buffer", "location", "width", "height", "bilinear"]) {
      assert.ok(Object.hasOwn(inputProperties, property), `input.${property}`);
    }

    const uniformType = getObjectAt(schema, ["definitions", "uniform", "properties", "type"]);
    assert.deepStrictEqual(uniformType.enum, ["float", "int", "ivec3", "vec2", "vec3", "vec4", "matrix4x4"]);
  });

  it("covers current warning and compliance metadata constraints", () => {
    const gpuWarnlist = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "gpu-warnlist.json"));
    assert.deepStrictEqual(gpuWarnlist.required, ["renderer", "version", "vendor"]);

    const regionalCompliances = readJsonFile<JsonObject>(
      path.join(process.cwd(), "assets", "linters", "regional-compliancies.json")
    );
    const propertyNames = getObjectAt(regionalCompliances, ["propertyNames"]);
    assert.strictEqual(propertyNames.pattern, "^[A-Z]{3}$");
  });

  it("constrains standalone animation texture metadata", () => {
    const schema = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "animation.mcmeta.json"));
    const animationProperties = getObjectAt(schema, ["properties", "animation", "properties"]);

    const frametime = getObjectAt(animationProperties, ["frametime"]);
    assert.strictEqual(frametime.minimum, 1);

    const frames = getObjectAt(animationProperties, ["frames", "items"]);
    const frameShapes = getArrayProperty(frames, "oneOf");
    const frameIndex = assertJsonObjectValue(frameShapes[0], "frames.items.oneOf[0]");
    assert.strictEqual(frameIndex.minimum, 0);

    const frameObject = assertJsonObjectValue(frameShapes[1], "frames.items.oneOf[1]");
    const frameObjectProperties = getObjectAt(frameObject, ["properties"]);
    assert.strictEqual(getObjectAt(frameObjectProperties, ["index"]).minimum, 0);
    assert.strictEqual(getObjectAt(frameObjectProperties, ["time"]).minimum, 1);

    assert.strictEqual(getObjectAt(animationProperties, ["width"]).minimum, 1);
    assert.strictEqual(getObjectAt(animationProperties, ["height"]).minimum, 1);
  });

  it("marks legacy item model overrides and lefthanded predicates correctly", () => {
    const schema = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "models-item.json"));
    const overrides = getObjectAt(schema, ["properties", "overrides"]);
    assert.match(String(overrides.description), /1\.21\.4/);
    assert.match(String(overrides.deprecationMessage), /items/);

    const lefthanded = getObjectAt(
      schema,
      ["properties", "overrides", "items", "properties", "predicate", "properties", "lefthanded"]
    );
    assert.strictEqual(lefthanded.type, "number");
    assert.deepStrictEqual(lefthanded.enum, [0, 1]);
  });

  it("separates current item model top-level and special model types", () => {
    const schema = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "items.json"));

    const topLevelTypes = getStringArrayProperty(getObjectAt(schema, ["definitions", "topLevelType"]), "enum");
    for (const type of [
      "minecraft:model",
      "minecraft:composite",
      "minecraft:condition",
      "minecraft:select",
      "minecraft:range_dispatch",
      "minecraft:empty",
      "minecraft:bundle/selected_item",
      "minecraft:special"
    ]) {
      assert.ok(topLevelTypes.includes(type), `top-level type ${type}`);
    }

    for (const type of ["minecraft:banner", "minecraft:bed", "minecraft:standing_sign", "minecraft:hanging_sign"]) {
      assert.strictEqual(topLevelTypes.includes(type), false, `top-level enum should not contain ${type}`);
    }

    const specialTypes = getStringArrayProperty(getObjectAt(schema, ["definitions", "specialModelType"]), "enum");
    for (const type of [
      "minecraft:banner",
      "minecraft:bell",
      "minecraft:book",
      "minecraft:chest",
      "minecraft:conduit",
      "minecraft:copper_golem_statue",
      "minecraft:decorated_pot",
      "minecraft:end_cube",
      "minecraft:head",
      "minecraft:player_head",
      "minecraft:shield",
      "minecraft:shulker_box",
      "minecraft:trident"
    ]) {
      assert.ok(specialTypes.includes(type), `special type ${type}`);
    }

    for (const type of ["minecraft:bed", "minecraft:standing_sign", "minecraft:hanging_sign"]) {
      assert.strictEqual(specialTypes.includes(type), false, `removed special enum should not contain ${type}`);
    }
  });

  it("covers current item model property groups and special fields", () => {
    const schema = readJsonFile<JsonObject>(path.join(process.cwd(), "assets", "linters", "items.json"));

    const conditionProperties = getStringArrayProperty(getObjectAt(schema, ["definitions", "conditionProperty"]), "enum");
    assert.ok(conditionProperties.includes("minecraft:keybind_down"));
    assert.strictEqual(conditionProperties.includes("minecraft:block_state"), false);

    const selectProperties = getStringArrayProperty(getObjectAt(schema, ["definitions", "selectProperty"]), "enum");
    assert.ok(selectProperties.includes("minecraft:block_state"));
    assert.strictEqual(selectProperties.includes("minecraft:damage"), false);

    const rangeProperties = getStringArrayProperty(getObjectAt(schema, ["definitions", "rangeDispatchProperty"]), "enum");
    assert.ok(rangeProperties.includes("minecraft:use_duration"));
    assert.strictEqual(rangeProperties.includes("minecraft:selected"), false);

    const bannerAttachment = getObjectAt(schema, ["definitions", "bannerSpecialModel", "properties", "attachment"]);
    assert.deepStrictEqual(bannerAttachment.enum, ["ground", "wall"]);

    const bookOpenAngle = getObjectAt(schema, ["definitions", "bookSpecialModel", "properties", "open_angle"]);
    assert.strictEqual(bookOpenAngle.type, "integer");

    const chestRequired = getStringArrayProperty(getObjectAt(schema, ["definitions", "chestSpecialModel"]), "required");
    assert.ok(chestRequired.includes("texture"));
    assert.ok(Object.hasOwn(getObjectAt(schema, ["definitions", "chestSpecialModel", "properties"]), "chest_type"));

    const shulkerRequired = getStringArrayProperty(getObjectAt(schema, ["definitions", "shulkerBoxSpecialModel"]), "required");
    assert.ok(shulkerRequired.includes("texture"));
    const shulkerProperties = getObjectAt(schema, ["definitions", "shulkerBoxSpecialModel", "properties"]);
    assert.strictEqual(shulkerProperties.orientation, undefined);

    const headProperties = getObjectAt(schema, ["definitions", "headSpecialModel", "properties"]);
    assert.ok(Object.hasOwn(headProperties, "texture"));
    assert.ok(Object.hasOwn(headProperties, "animation"));
  });
});

function collectJsonFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(file));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(file);
    }
  }

  return files;
}

function readJsonFile<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function getObjectAt(root: unknown, segments: string[]): JsonObject {
  let value = root;
  let location = "schema";

  for (const segment of segments) {
    assertJsonObject(value, location);
    value = value[segment];
    location += `.${segment}`;
  }

  assertJsonObject(value, location);
  return value;
}

function assertJsonObject(value: unknown, location: string): asserts value is JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${location} should be an object`);
}

function assertJsonObjectValue(value: unknown, location: string): JsonObject {
  assertJsonObject(value, location);
  return value;
}

function getArrayProperty(value: JsonObject, propertyName: string): unknown[] {
  const property = value[propertyName];
  assert.ok(Array.isArray(property), `${propertyName} should be an array`);
  return property;
}

function getStringArrayProperty(value: JsonObject, propertyName: string): string[] {
  const property = getArrayProperty(value, propertyName);
  assert.ok(property.every(item => typeof item === "string"), `${propertyName} should only contain strings`);
  return property;
}

function findMisspelledSchemaKeywords(
  value: unknown,
  location: string,
  misspelledKeywords: Set<string>,
  findings: string[]
): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => findMisspelledSchemaKeywords(item, `${location}[${index}]`, misspelledKeywords, findings));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (misspelledKeywords.has(key)) {
      findings.push(childLocation);
    }
    findMisspelledSchemaKeywords(child, childLocation, misspelledKeywords, findings);
  }
}
