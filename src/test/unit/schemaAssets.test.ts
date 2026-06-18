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

describe("schema assets", () => {
  it("parses every bundled JSON schema asset", () => {
    for (const file of collectJsonFiles(path.join(process.cwd(), "assets", "linters"))) {
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")), file);
    }
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
