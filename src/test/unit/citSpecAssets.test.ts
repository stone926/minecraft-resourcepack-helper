import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCitBuiltinResourceCatalog } from "../../cit/citBuiltinResourceCatalog";
import { CitSpecService } from "../../cit/citSpecService";
import type { CitSpecFragment } from "../../cit/citSpecTypes";

type JsonObject = Record<string, unknown>;

const CIT_ASSETS = path.join(process.cwd(), "assets", "cit");
const EN_CIT = path.join(CIT_ASSETS, "en");
const ZH_CIT = path.join(CIT_ASSETS, "zh-cn");
const requiredFiles = [
  "armor.json",
  "base.json",
  "elytra.json",
  "enchantment.json",
  "global-properties.json",
  "item.json"
];

describe("CIT spec assets", () => {
  it("parses every bundled CIT spec JSON asset", () => {
    for (const file of collectJsonFiles(CIT_ASSETS)) {
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")), file);
    }
  });

  it("loads the versioned builtin resource catalog with canonical unique values", () => {
    const catalog = loadCitBuiltinResourceCatalog(CIT_ASSETS);

    assert.strictEqual(catalog.schemaVersion, 1);
    assert.strictEqual(catalog.defaultNamespace, "minecraft");
    assert.deepStrictEqual(
      [catalog.items.length, catalog.enchantments.length],
      [95, 42]
    );
    assert.ok(catalog.items.includes("minecraft:stick"));
    assert.ok(catalog.enchantments.includes("minecraft:sharpness"));
    assert.deepStrictEqual(catalog.armorSuffixes, [
      "_helmet",
      "_chestplate",
      "_leggings",
      "_boots"
    ]);
  });

  it("rejects malformed builtin resource catalogs at the asset boundary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-res-cit-catalog-"));
    try {
      fs.writeFileSync(path.join(root, "builtin-resource-ids.json"), JSON.stringify({
        schemaVersion: 1,
        defaultNamespace: "minecraft",
        items: ["not a resource id"],
        enchantments: [],
        armorSuffixes: ["helmet"]
      }));
      assert.throws(
        () => loadCitBuiltinResourceCatalog(root),
        /items contains invalid resource path/
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ships required fragments in both locales", () => {
    assert.deepStrictEqual(collectRelativeJsonFiles(EN_CIT), requiredFiles);
    assert.deepStrictEqual(collectRelativeJsonFiles(ZH_CIT), requiredFiles);
  });

  it("keeps en and zh-cn CIT spec structures aligned", () => {
    for (const relPath of requiredFiles) {
      const en = readJsonFile<JsonObject>(path.join(EN_CIT, relPath));
      const zh = readJsonFile<JsonObject>(path.join(ZH_CIT, relPath));
      compareStructures(en, zh, relPath);
    }
  });

  it("declares required metadata for every key and pattern", () => {
    for (const file of [...collectJsonFiles(EN_CIT), ...collectJsonFiles(ZH_CIT)]) {
      const fragment = readJsonFile<CitSpecFragment>(file);
      for (const [key, spec] of Object.entries({ ...fragment.keys, ...fragment.patterns })) {
        assert.ok(spec.valueType, `${file}:${key} missing valueType`);
        assert.ok(spec.scope?.length, `${file}:${key} missing scope`);
        assert.ok(spec.title, `${file}:${key} missing title`);
        assert.ok(spec.description, `${file}:${key} missing description`);
      }
    }
  });

  it("keeps enum values identical across locales", () => {
    for (const relPath of requiredFiles) {
      const en = readJsonFile<CitSpecFragment>(path.join(EN_CIT, relPath));
      const zh = readJsonFile<CitSpecFragment>(path.join(ZH_CIT, relPath));
      for (const section of ["keys", "patterns"] as const) {
        for (const key of Object.keys(en[section])) {
          assert.deepStrictEqual(zh[section][key].enum, en[section][key].enum, `${relPath}:${section}.${key}`);
        }
      }
    }
  });

  it("localizes every CIT hover and completion annotation", () => {
    for (const relPath of requiredFiles) {
      const enEntries = collectLocalizedStrings(readJsonFile<unknown>(path.join(EN_CIT, relPath)));
      const zhEntries = collectLocalizedStrings(readJsonFile<unknown>(path.join(ZH_CIT, relPath)));

      assert.deepStrictEqual([...zhEntries.keys()].sort(), [...enEntries.keys()].sort(), relPath);
      for (const [location, enValue] of enEntries) {
        const zhValue = zhEntries.get(location) ?? "";
        assert.ok(enValue.trim(), `${relPath}.${location}: EN value should not be empty`);
        assert.ok(zhValue.trim(), `${relPath}.${location}: ZH value should not be empty`);
        assert.ok(!/[\u4e00-\u9fff]/.test(enValue), `${relPath}.${location}: EN value contains Chinese`);
        if (/[A-Za-z]/.test(enValue)) {
          assert.ok(/[\u4e00-\u9fff]/.test(zhValue), `${relPath}.${location}: ZH value should contain Chinese`);
        }
      }
    }
  });

  it("falls back to English for unsupported Chinese locales", () => {
    const service = new CitSpecService(CIT_ASSETS);
    const english = service.getCitSpec("item", "en").keys.get("texture")?.title;
    const simplifiedChinese = service.getCitSpec("item", "zh-cn").keys.get("texture")?.title;

    assert.notStrictEqual(simplifiedChinese, english);
    assert.strictEqual(service.getCitSpec("item", "zh-tw").keys.get("texture")?.title, english);
  });

  it("does not conflict when fragments are merged", () => {
    const service = new CitSpecService(CIT_ASSETS);
    for (const locale of ["en", "zh-cn"]) {
      service.getGlobalSpec(locale);
      service.getAllCitSpec(locale);
      for (const type of ["item", "armor", "elytra", "enchantment"] as const) {
        service.getCitSpec(type, locale);
      }
    }
  });

  it("keeps pattern names separate from exact keys", () => {
    for (const localeRoot of [EN_CIT, ZH_CIT]) {
      for (const file of collectJsonFiles(localeRoot)) {
        const fragment = readJsonFile<CitSpecFragment>(file);
        for (const pattern of Object.keys(fragment.patterns)) {
          assert.strictEqual(Object.hasOwn(fragment.keys, pattern), false, `${file}:${pattern}`);
        }
      }
    }
  });
});

function collectRelativeJsonFiles(root: string): string[] {
  return collectJsonFiles(root).map(file => path.relative(root, file)).sort();
}

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

const localizedKeys = new Set(["title", "description", "runtimeNote"]);

function collectLocalizedStrings(value: unknown): Map<string, string> {
  const entries = new Map<string, string>();

  function visit(child: unknown, location: string): void {
    if (Array.isArray(child)) {
      child.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (!child || typeof child !== "object") {
      return;
    }

    for (const [key, nested] of Object.entries(child)) {
      const nestedLocation = location ? `${location}.${key}` : key;
      if (localizedKeys.has(key) && typeof nested === "string") {
        entries.set(nestedLocation, nested);
      } else {
        visit(nested, nestedLocation);
      }
    }
  }

  visit(value, "");
  return entries;
}

function compareStructures(en: unknown, zh: unknown, location: string): void {
  if (typeof en !== typeof zh) {
    assert.fail(`${location}: type mismatch`);
  }
  if (typeof en !== "object" || en === null) {
    assert.deepStrictEqual(zh, en, location);
    return;
  }
  if (Array.isArray(en)) {
    assert.deepStrictEqual(zh, en, location);
    return;
  }

  assert.ok(zh && typeof zh === "object" && !Array.isArray(zh), `${location}: zh should be object`);
  const enObj = en as JsonObject;
  const zhObj = zh as JsonObject;
  const enKeys = Object.keys(enObj).sort();
  const zhKeys = Object.keys(zhObj).sort();
  assert.deepStrictEqual(zhKeys, enKeys, location);

  for (const key of enKeys) {
    if (!localizedKeys.has(key)) {
      compareStructures(enObj[key], zhObj[key], `${location}.${key}`);
    }
  }
}
