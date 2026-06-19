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
