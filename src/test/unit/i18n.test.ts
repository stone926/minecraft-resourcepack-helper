import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMsg, promptMsg } from "../../commands/constants";
import { lm, type LocalizedMessage } from "../../i18n/messages";
import { readCombinedModelPreviewScript } from "./helpers/webviewScripts";

interface PackageJson {
  displayName?: string;
  description?: string;
  contributes?: {
    commands?: Array<Record<string, unknown>>;
    configuration?: Record<string, unknown> | Array<Record<string, unknown>>;
    jsonValidation?: Array<Record<string, unknown>>;
    views?: Record<string, Array<Record<string, unknown>>>;
    viewsContainers?: Record<string, Array<Record<string, unknown>>>;
  };
}

interface LocalizedManifestField {
  location: string;
  value: unknown;
}

describe("i18n", () => {
  it("localizes every user-facing manifest field", () => {
    const packageJson = readJsonFile<PackageJson>(path.join(process.cwd(), "package.json"));

    const fields = collectLocalizedManifestFields(packageJson);
    assert.ok(fields.length > 0, "package.json should expose localizable fields");
    for (const field of fields) {
      assertIsPackageNlsReference(field.value, field.location);
    }
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
    for (const [key, value] of Object.entries(defaultBundle)) {
      assert.strictEqual(value, key, `default runtime translation should match its source key: ${key}`);
    }
  });

  it("keeps localization placeholders aligned and translations non-empty", () => {
    for (const [defaultFile, translatedFile, identicalAllowlist] of [
      ["package.nls.json", "package.nls.zh-cn.json", new Set<string>()],
      [path.join("l10n", "bundle.l10n.json"), path.join("l10n", "bundle.l10n.zh-cn.json"), new Set(["3/4"])]
    ] as const) {
      const defaultBundle = readJsonFile<Record<string, string>>(path.join(process.cwd(), defaultFile));
      const translatedBundle = readJsonFile<Record<string, string>>(path.join(process.cwd(), translatedFile));

      for (const [key, defaultValue] of Object.entries(defaultBundle)) {
        const translatedValue = translatedBundle[key];
        assert.ok(defaultValue.trim(), `${defaultFile}:${key} should not be empty`);
        assert.ok(translatedValue?.trim(), `${translatedFile}:${key} should not be empty`);
        assert.deepStrictEqual(
          collectPlaceholders(translatedValue).sort(),
          collectPlaceholders(defaultValue).sort(),
          `${translatedFile}:${key} should preserve indexed placeholders`
        );
        if (!identicalAllowlist.has(key)) {
          assert.notStrictEqual(translatedValue, defaultValue, `${translatedFile}:${key} should be translated`);
        }
      }
    }
  });

  it("rejects unallowlisted runtime message keys that cannot be collected statically", () => {
    assert.deepStrictEqual(collectNonStaticL10nCalls(), []);
  });

  it("does not collect test-only localization calls as production bundle keys", () => {
    const testOnlyMessage = lm("I18N test-only localization collector sentinel");
    assert.strictEqual(collectRuntimeL10nKeys().has(testOnlyMessage.message), false);
  });

  it("rejects raw string arrays used as Quick Pick choices", () => {
    assert.deepStrictEqual(collectRawQuickPickStringArrays(), []);
  });

  it("keeps model preview webview UI strings behind l10n helpers", () => {
    const webviewSource = fs.readFileSync(path.join(process.cwd(), "src", "modelPreview", "host", "ModelPreviewWebview.ts"), "utf8");
    const scriptSource = readCombinedModelPreviewScript();

    assert.ok(webviewSource.includes("__MC_RES_HELPER_L10N__"), "webview HTML should inject the host l10n dictionary");
    assert.strictEqual(webviewSource.includes('<html lang="en">'), false, "webview language should follow VS Code");
    for (const htmlText of [
      ">Model Preview<",
      ">Reset<",
      ">Refresh<",
      ">Issues<",
      ">Dependencies<",
      ">Cancel<",
      "title=\"Reset view\"",
      "aria-label=\"Resize details panel\""
    ]) {
      assert.strictEqual(webviewSource.includes(htmlText), false, `webview HTML should not hardcode ${htmlText}`);
    }

    assert.ok(scriptSource.includes('t("No issues")'), "empty issue state should use the webview l10n helper");
    assert.ok(scriptSource.includes('t("Persp")'), "perspective camera label should use the webview l10n helper");
    assert.ok(scriptSource.includes('t("Ortho")'), "orthographic camera label should use the webview l10n helper");
    assert.ok(scriptSource.includes('code: "Texture load failed: {0}"'), "render issues should send stable message codes to the host");
    assert.strictEqual(scriptSource.includes("Texture load failed: ${"), false, "render issues should not build user text with templates");
    assert.strictEqual(scriptSource.includes('textContent = "Width and height must be 1-8192 px."'), false, "export validation should not hardcode UI text");
  });
});

function collectLocalizedManifestFields(packageJson: PackageJson): LocalizedManifestField[] {
  const fields: LocalizedManifestField[] = [
    { location: "displayName", value: packageJson.displayName },
    { location: "description", value: packageJson.description }
  ];
  const contributes = packageJson.contributes;
  if (!contributes) {
    return fields;
  }

  for (const [index, command] of (contributes.commands ?? []).entries()) {
    collectKnownStringFields(command, `contributes.commands[${index}]`, ["title", "shortTitle", "category"], fields);
  }
  for (const [container, views] of Object.entries(contributes.viewsContainers ?? {})) {
    views.forEach((view, index) => collectKnownStringFields(
      view,
      `contributes.viewsContainers.${container}[${index}]`,
      ["title"],
      fields
    ));
  }
  for (const [container, views] of Object.entries(contributes.views ?? {})) {
    views.forEach((view, index) => collectKnownStringFields(
      view,
      `contributes.views.${container}[${index}]`,
      ["name"],
      fields
    ));
  }
  (contributes.jsonValidation ?? []).forEach((registration, index) => collectKnownStringFields(
    registration,
    `contributes.jsonValidation[${index}]`,
    ["url"],
    fields
  ));

  collectConfigurationLocalizedFields(contributes.configuration, "contributes.configuration", fields);
  return fields;
}

function collectKnownStringFields(
  value: Record<string, unknown>,
  location: string,
  keys: string[],
  fields: LocalizedManifestField[]
): void {
  for (const key of keys) {
    if (key in value) {
      fields.push({ location: `${location}.${key}`, value: value[key] });
    }
  }
}

const configurationLocalizedKeys = new Set([
  "title",
  "description",
  "markdownDescription",
  "deprecationMessage",
  "enumDescriptions",
  "markdownEnumDescriptions"
]);

function collectConfigurationLocalizedFields(
  value: unknown,
  location: string,
  fields: LocalizedManifestField[]
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectConfigurationLocalizedFields(item, `${location}[${index}]`, fields));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (configurationLocalizedKeys.has(key) && typeof child === "string") {
      fields.push({ location: childLocation, value: child });
      continue;
    }
    if (configurationLocalizedKeys.has(key) && Array.isArray(child)) {
      child.forEach((item, index) => fields.push({ location: `${childLocation}[${index}]`, value: item }));
      continue;
    }
    collectConfigurationLocalizedFields(child, childLocation, fields);
  }
}

function assertIsPackageNlsReference(value: unknown, label: string): void {
  assert.match(typeof value === "string" ? value : "", /^%[^%]+%$/, `${label} should use a package.nls placeholder`);
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
    ...Object.values(errorMsg).map(messageKey),
    ...Object.values(promptMsg).map(messageKey)
  ]);

  for (const file of collectProductionTypeScriptFiles()) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/vscode\.l10n\.t\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      keys.add(unescapeStringLiteral(match[2]));
    }
    for (const match of source.matchAll(/\blm\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      keys.add(unescapeStringLiteral(match[2]));
    }
    for (const match of source.matchAll(/\blocalize\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      keys.add(unescapeStringLiteral(match[2]));
    }
  }

  return keys;
}

function collectNonStaticL10nCalls(): string[] {
  const calls: string[] = [];
  const root = path.join(process.cwd(), "src");
  for (const file of collectProductionTypeScriptFiles()) {
    const relativeFile = path.relative(root, file).replaceAll(path.sep, "/");
    if (relativeFile === "i18n/runtime.ts" || relativeFile === "i18n/messages.ts") {
      continue;
    }

    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/vscode\.l10n\.t\(\s*([^"'`{])/g)) {
      const index = match.index ?? 0;
      calls.push(`${path.relative(process.cwd(), file)}:${lineNumberAt(source, index)}`);
    }
    for (const match of source.matchAll(/\blm\(\s*([A-Za-z_$][\w.$]*)/g)) {
      const signature = `${relativeFile}:${match[1]}`;
      if (!nonStaticLmCallAllowlist.has(signature)) {
        const index = match.index ?? 0;
        calls.push(`${path.relative(process.cwd(), file)}:${lineNumberAt(source, index)}`);
      }
    }
  }
  return calls.sort();
}

const nonStaticLmCallAllowlist = new Set([
  // The webview sends stable code/args pairs; modelPreviewWebviewMessages registers every accepted code.
  "modelPreview/host/ModelPreviewPanel.ts:message.code"
]);

function collectRawQuickPickStringArrays(): string[] {
  const calls: string[] = [];
  for (const file of collectProductionTypeScriptFiles()) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\.showQuickPick\(\s*\[\s*["'`]/g)) {
      calls.push(`${path.relative(process.cwd(), file)}:${lineNumberAt(source, match.index ?? 0)}`);
    }
  }
  return calls.sort();
}

function collectProductionTypeScriptFiles(): string[] {
  const root = path.join(process.cwd(), "src");
  return collectTypeScriptFiles(root).filter(file => {
    const relative = path.relative(root, file);
    return relative !== "test" && !relative.startsWith(`test${path.sep}`);
  });
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

function messageKey(value: string | LocalizedMessage): string {
  return typeof value === "string" ? value : value.message;
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split(/\r\n|\n|\r/).length;
}

function unescapeStringLiteral(value: string): string {
  return value.replace(/\\([\\'"`])/g, "$1");
}

function collectPlaceholders(value: string): string[] {
  return value.match(/\{\d+\}/g) ?? [];
}
