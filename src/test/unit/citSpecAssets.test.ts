import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { CitSpecService } from "../../services/citSpecService";
import type { CitSpecFragment } from "../../utils/citSpecTypes";

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
    for (const file of [...collectJsonFiles(EN_CIT), ...collectJsonFiles(ZH_CIT)]) {
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")), file);
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

  it("keeps pattern names separate from exact keys and rule ids unique", () => {
    for (const localeRoot of [EN_CIT, ZH_CIT]) {
      const ruleIds = new Set<string>();
      for (const file of collectJsonFiles(localeRoot)) {
        const fragment = readJsonFile<CitSpecFragment>(file);
        for (const pattern of Object.keys(fragment.patterns)) {
          assert.strictEqual(Object.hasOwn(fragment.keys, pattern), false, `${file}:${pattern}`);
        }
        for (const rule of fragment.rules) {
          assert.strictEqual(ruleIds.has(rule.id), false, `duplicate rule ${rule.id}`);
          ruleIds.add(rule.id);
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
