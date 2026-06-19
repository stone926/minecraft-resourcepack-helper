import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMsg, promptMsg } from "../../commands/constants";

interface PackageJson {
  displayName?: string;
  description?: string;
  contributes?: {
    configuration?: {
      title?: string;
    };
  };
}

describe("i18n", () => {
  it("localizes core user-facing package metadata", () => {
    const packageJson = readJsonFile<PackageJson>(path.join(process.cwd(), "package.json"));

    assertIsPackageNlsReference(packageJson.displayName, "displayName");
    assertIsPackageNlsReference(packageJson.description, "description");
    assertIsPackageNlsReference(packageJson.contributes?.configuration?.title, "contributes.configuration.title");
  });

  it("keeps package localization bundles aligned with package.json placeholders", () => {
    const packageJson = readJsonFile<unknown>(path.join(process.cwd(), "package.json"));
    const packageKeys = collectPackageNlsKeys(packageJson);
    const defaultBundle = readJsonFile<Record<string, string>>(path.join(process.cwd(), "package.nls.json"));
    const zhBundle = readJsonFile<Record<string, string>>(path.join(process.cwd(), "package.nls.zh-cn.json"));

    assert.ok(packageKeys.size > 0, "package.json should use package.nls placeholders");
    assert.deepStrictEqual(missingKeys(defaultBundle, packageKeys), []);
    assert.deepStrictEqual(missingKeys(zhBundle, packageKeys), []);
    assert.deepStrictEqual(extraKeys(defaultBundle, packageKeys), []);
    assert.deepStrictEqual(Object.keys(zhBundle).sort(), Object.keys(defaultBundle).sort());
  });

  it("keeps runtime localization bundles aligned with source keys", () => {
    const runtimeKeys = collectRuntimeL10nKeys();
    const defaultBundle = readJsonFile<Record<string, string>>(path.join(process.cwd(), "l10n", "bundle.l10n.json"));
    const zhBundle = readJsonFile<Record<string, string>>(path.join(process.cwd(), "l10n", "bundle.l10n.zh-cn.json"));

    assert.ok(runtimeKeys.size > 0, "source should use vscode.l10n.t for runtime UI strings");
    assert.deepStrictEqual(missingKeys(defaultBundle, runtimeKeys), []);
    assert.deepStrictEqual(missingKeys(zhBundle, runtimeKeys), []);
    assert.deepStrictEqual(extraKeys(defaultBundle, runtimeKeys), []);
    assert.deepStrictEqual(Object.keys(zhBundle).sort(), Object.keys(defaultBundle).sort());
  });
});

function assertIsPackageNlsReference(value: string | undefined, label: string): void {
  assert.match(value ?? "", /^%[^%]+%$/, `${label} should use a package.nls placeholder`);
}

function collectPackageNlsKeys(value: unknown): Set<string> {
  const keys = new Set<string>();
  collectPackageNlsKeysInto(value, keys);
  return keys;
}

function collectPackageNlsKeysInto(value: unknown, keys: Set<string>): void {
  if (typeof value === "string") {
    const match = /^%([^%]+)%$/.exec(value);
    if (match) {
      keys.add(match[1]);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectPackageNlsKeysInto(item, keys));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  Object.values(value).forEach(child => collectPackageNlsKeysInto(child, keys));
}

function collectRuntimeL10nKeys(): Set<string> {
  const keys = new Set<string>([
    ...Object.values(errorMsg),
    ...Object.values(promptMsg)
  ]);

  for (const file of collectTypeScriptFiles(path.join(process.cwd(), "src"))) {
    const source = fs.readFileSync(file, "utf8");
    const literalCalls = source.matchAll(/vscode\.l10n\.t\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g);
    for (const match of literalCalls) {
      keys.add(unescapeStringLiteral(match[2]));
    }
  }

  return keys;
}

function collectTypeScriptFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(file));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(file);
    }
  }

  return files;
}

function missingKeys(bundle: Record<string, string>, expectedKeys: Set<string>): string[] {
  return [...expectedKeys].filter(key => !(key in bundle)).sort();
}

function extraKeys(bundle: Record<string, string>, expectedKeys: Set<string>): string[] {
  return Object.keys(bundle).filter(key => !expectedKeys.has(key)).sort();
}

function readJsonFile<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function unescapeStringLiteral(value: string): string {
  return value.replace(/\\([\\'"`])/g, "$1");
}
