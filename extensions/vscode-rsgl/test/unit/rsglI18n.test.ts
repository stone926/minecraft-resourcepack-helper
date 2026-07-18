import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const rsglPackageRoot = path.join(process.cwd(), "extensions", "vscode-rsgl");

interface RsglPackageJson {
  displayName?: string;
  description?: string;
  contributes?: {
    commands?: Array<{ command?: string; title?: string }>;
    configuration?: {
      title?: string;
      properties?: Record<string, { description?: string }>;
    };
    jsonValidation?: Array<{ fileMatch?: string; url?: string }>;
  };
}

describe("RSGL extension i18n", () => {
  it("localizes every user-facing package contribution", () => {
    const packageJson = readJsonFile<RsglPackageJson>(
      path.join(rsglPackageRoot, "package.json")
    );

    assertIsPackageNlsReference(packageJson.displayName, "displayName");
    assertIsPackageNlsReference(packageJson.description, "description");

    const commands = packageJson.contributes?.commands ?? [];
    assert.ok(commands.length > 0, "package.json should contribute commands");
    for (const command of commands) {
      assertIsPackageNlsReference(command.title, `command ${command.command ?? "<missing id>"} title`);
    }

    const configuration = packageJson.contributes?.configuration;
    assertIsPackageNlsReference(configuration?.title, "configuration title");
    const properties = Object.entries(configuration?.properties ?? {});
    assert.ok(properties.length > 0, "package.json should contribute configuration properties");
    for (const [key, property] of properties) {
      assertIsPackageNlsReference(property.description, `configuration ${key} description`);
    }

    const validations = packageJson.contributes?.jsonValidation ?? [];
    assert.ok(validations.length > 0, "package.json should contribute JSON validation");
    for (const validation of validations) {
      assert.match(
        validation.url ?? "",
        /^%schema\.[^%]+\.url%$/,
        `jsonValidation ${validation.fileMatch ?? "<missing fileMatch>"} should select a localized schema`
      );
    }
  });

  it("keeps package localization bundles aligned with package.json placeholders", () => {
    const packageJson = readJsonFile<unknown>(path.join(rsglPackageRoot, "package.json"));
    const packageKeys = collectPackageNlsKeys(packageJson);
    const defaultBundle = readJsonFile<Record<string, string>>(path.join(rsglPackageRoot, "package.nls.json"));
    const zhBundle = readJsonFile<Record<string, string>>(path.join(rsglPackageRoot, "package.nls.zh-cn.json"));

    assert.ok(packageKeys.size > 0, "package.json should use package.nls placeholders");
    assert.deepStrictEqual(missingKeys(defaultBundle, packageKeys), []);
    assert.deepStrictEqual(missingKeys(zhBundle, packageKeys), []);
    assert.deepStrictEqual(extraKeys(defaultBundle, packageKeys), []);
    assert.deepStrictEqual(Object.keys(zhBundle).sort(), Object.keys(defaultBundle).sort());

    const allowedTechnicalSameValues = new Set(["config.title"]);
    for (const key of packageKeys) {
      assert.ok(defaultBundle[key].trim().length > 0, `${key} default package translation should not be empty`);
      assert.ok(zhBundle[key].trim().length > 0, `${key} zh-cn package translation should not be empty`);
      if (!allowedTechnicalSameValues.has(key)) {
        assert.notStrictEqual(zhBundle[key], defaultBundle[key], `${key} should not fall back to English in zh-cn`);
      }
    }
  });

  it("ships structurally aligned English and Chinese project configuration schemas", () => {
    const packageJson = readJsonFile<RsglPackageJson>(path.join(rsglPackageRoot, "package.json"));
    const defaultBundle = readJsonFile<Record<string, string>>(path.join(rsglPackageRoot, "package.nls.json"));
    const zhBundle = readJsonFile<Record<string, string>>(path.join(rsglPackageRoot, "package.nls.zh-cn.json"));
    const validations = packageJson.contributes?.jsonValidation ?? [];

    for (const validation of validations) {
      const key = packageNlsKey(validation.url);
      const enPath = resolveBundledPath(defaultBundle[key], key, "English");
      const zhPath = resolveBundledPath(zhBundle[key], key, "Chinese");
      assert.match(normalizeRelativePath(enPath), /\/schemas\/en\//);
      assert.match(normalizeRelativePath(zhPath), /\/schemas\/zh-cn\//);
      assert.ok(fs.existsSync(enPath), `English schema does not exist: ${enPath}`);
      assert.ok(fs.existsSync(zhPath), `Chinese schema does not exist: ${zhPath}`);

      const enSchema = readJsonFile<unknown>(enPath);
      const zhSchema = readJsonFile<unknown>(zhPath);
      assert.deepStrictEqual(schemaStructure(zhSchema), schemaStructure(enSchema));

      const enStrings = collectSchemaLocalizedStrings(enSchema);
      const zhStrings = collectSchemaLocalizedStrings(zhSchema);
      assert.ok(enStrings.length > 0, `${enPath} should contain localizable schema text`);
      assert.strictEqual(zhStrings.length, enStrings.length);
      assert.deepStrictEqual(zhStrings.map(item => item.location), enStrings.map(item => item.location));
      for (const item of enStrings) {
        assert.doesNotMatch(item.value, /[\u4e00-\u9fff]/, `English schema text at ${item.location}`);
      }
      for (const item of zhStrings) {
        assert.match(item.value, /[\u4e00-\u9fff]/, `Chinese schema text at ${item.location}`);
      }
    }
  });

  it("ships aligned English and Chinese Marketplace guides with reciprocal navigation", () => {
    const englishReadme = fs.readFileSync(path.join(rsglPackageRoot, "README.md"), "utf8");
    const chineseReadme = fs.readFileSync(path.join(rsglPackageRoot, "README_CN.md"), "utf8");
    const mainChineseReadme = fs.readFileSync(path.join(process.cwd(), "README_CN.md"), "utf8");

    assert.match(englishReadme, /^# RSGL - Resourcepack Generation Language\r?\n\r?\n\[中文说明\]\(README_CN\.md\)/);
    assert.match(chineseReadme, /^# RSGL - 资源包生成语言\r?\n\r?\n\[English README\]\(README\.md\)/);
    assert.match(chineseReadme, /[\u4e00-\u9fff]/, "Chinese README should contain translated prose");
    const englishHeadingLevels = markdownHeadingLevels(englishReadme);
    assert.strictEqual(englishHeadingLevels.length, 10, "RSGL guide should retain every documented section");
    assert.deepStrictEqual(markdownHeadingLevels(chineseReadme), englishHeadingLevels);

    const englishCodeBlocks = markdownCodeBlocks(englishReadme);
    const chineseCodeBlocks = markdownCodeBlocks(chineseReadme);
    assert.strictEqual(englishCodeBlocks.length, 10, "RSGL guide should retain all runnable examples");
    assert.deepStrictEqual(chineseCodeBlocks, englishCodeBlocks);

    assert.match(
      mainChineseReadme,
      /\[RSGL 配套扩展指南\]\(extensions\/vscode-rsgl\/README_CN\.md\)/
    );
  });

  it("keeps runtime localization bundles aligned with source keys", () => {
    const runtimeKeys = collectRuntimeL10nKeys();
    const defaultBundle = readJsonFile<Record<string, string>>(path.join(rsglPackageRoot, "l10n", "bundle.l10n.json"));
    const zhBundle = readJsonFile<Record<string, string>>(path.join(rsglPackageRoot, "l10n", "bundle.l10n.zh-cn.json"));

    assert.ok(runtimeKeys.size > 0, "source should use vscode.l10n.t for runtime UI strings");
    assert.deepStrictEqual(missingKeys(defaultBundle, runtimeKeys), []);
    assert.deepStrictEqual(missingKeys(zhBundle, runtimeKeys), []);
    assert.deepStrictEqual(extraKeys(defaultBundle, runtimeKeys), []);
    assert.deepStrictEqual(Object.keys(zhBundle).sort(), Object.keys(defaultBundle).sort());

    for (const key of runtimeKeys) {
      assert.ok(defaultBundle[key].trim().length > 0, `${key} default runtime translation should not be empty`);
      assert.ok(zhBundle[key].trim().length > 0, `${key} zh-cn runtime translation should not be empty`);
      assert.notStrictEqual(zhBundle[key], defaultBundle[key], `${key} should not fall back to English in zh-cn`);
      assert.deepStrictEqual(messagePlaceholders(defaultBundle[key]), messagePlaceholders(key), `${key} default placeholders`);
      assert.deepStrictEqual(messagePlaceholders(zhBundle[key]), messagePlaceholders(key), `${key} zh-cn placeholders`);
    }
  });

  it("keeps all generated build preview copy behind runtime localization", () => {
    const runtimeKeys = collectRuntimeL10nKeys();
    for (const key of [
      "RSGL Build Preview",
      "Entry: {0}",
      "Source root: {0}",
      "Output root: {0}",
      "Summary: {0} create, {1} update, {2} unchanged",
      "Planned Changes",
      "No file changes.",
      "Diff Preview",
      "Binary copy from {0}",
      "... {0} more diff line(s) omitted",
      "create",
      "update",
      "unchanged",
      "RSGL Workspace Build Preview",
      "Summary: {0} source directories, {1} created, {2} updated, {3} unchanged, {4} skipped.",
      "Skipped Source Directories",
      "Resource pack output root not found.",
      "No preview available.",
      "Unable to read RSGL copy source '{0}'.",
      "Unable to read RSGL output file '{0}'.",
      "Unsafe RSGL output path '{0}'."
    ]) {
      assert.ok(runtimeKeys.has(key), `build preview text should be localized: ${key}`);
    }

    const workspaceFormatter = fs.readFileSync(
      path.join(rsglPackageRoot, "src", "commands", "workspaceBuildPreview.ts"),
      "utf8"
    );
    assert.doesNotMatch(workspaceFormatter, /RSGL Workspace Build Preview|Skipped Source Directories|No preview\./);
  });

  it("rejects runtime l10n calls that cannot be collected statically", () => {
    assert.deepStrictEqual(collectNonStaticL10nCalls(), []);
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
  const keys = new Set<string>();

  for (const file of collectTypeScriptFiles(path.join(rsglPackageRoot, "src"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/vscode\.l10n\.t\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      keys.add(unescapeStringLiteral(match[2]));
    }
  }

  return keys;
}

function collectNonStaticL10nCalls(): string[] {
  const calls: string[] = [];
  for (const file of collectTypeScriptFiles(path.join(rsglPackageRoot, "src"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/vscode\.l10n\.t\(/g)) {
      const index = match.index ?? 0;
      const argumentSource = source.slice(index + match[0].length).trimStart();
      if (!/^["'`{]/.test(argumentSource)) {
        calls.push(`${path.relative(process.cwd(), file)}:${lineNumberAt(source, index)}`);
      }
    }
  }
  return calls.sort();
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

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split(/\r\n|\n|\r/).length;
}

function unescapeStringLiteral(value: string): string {
  return value.replace(/\\([\\'"`])/g, "$1");
}

function packageNlsKey(value: string | undefined): string {
  const match = /^%([^%]+)%$/.exec(value ?? "");
  assert.ok(match, `expected package.nls placeholder, got: ${value ?? "<missing>"}`);
  return match[1];
}

function resolveBundledPath(value: string | undefined, key: string, locale: string): string {
  assert.ok(value, `${locale} package.nls bundle is missing ${key}`);
  const resolved = path.resolve(rsglPackageRoot, value);
  const relative = path.relative(rsglPackageRoot, resolved);
  assert.ok(
    relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `${locale} package.nls path escapes the extension: ${value}`
  );
  return resolved;
}

const schemaLocalizedKeys = new Set([
  "title",
  "description",
  "markdownDescription",
  "deprecationMessage"
]);

function schemaStructure(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(schemaStructure);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    schemaLocalizedKeys.has(key) ? "<localized string>" : schemaStructure(child)
  ]));
}

function collectSchemaLocalizedStrings(
  value: unknown,
  location = "$",
  result: Array<{ location: string; value: string }> = []
): Array<{ location: string; value: string }> {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectSchemaLocalizedStrings(child, `${location}[${index}]`, result));
    return result;
  }
  if (!value || typeof value !== "object") {
    return result;
  }

  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (schemaLocalizedKeys.has(key)) {
      assert.strictEqual(typeof child, "string", `${childLocation} should be a string`);
      result.push({ location: childLocation, value: child as string });
    } else {
      collectSchemaLocalizedStrings(child, childLocation, result);
    }
  }
  return result.sort((left, right) => left.location.localeCompare(right.location));
}

function messagePlaceholders(value: string): string[] {
  return [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function markdownHeadingLevels(value: string): string[] {
  return [...value.matchAll(/^(#{1,6})\s+/gm)].map(match => match[1]);
}

function markdownCodeBlocks(value: string): Array<{ language: string; body: string }> {
  const normalized = value.replaceAll("\r\n", "\n");
  return [...normalized.matchAll(/^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm)].map(match => ({
    language: match[1],
    body: match[2]
  }));
}
