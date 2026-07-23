import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

interface ExtensionManifest {
  contributes?: {
    commands?: Array<{ command?: string; title?: string }>;
    configuration?: {
      properties?: Record<string, {
        description?: string;
        enumDescriptions?: string[];
      }>;
    };
    jsonValidation?: Array<{ fileMatch?: string; url?: string }>;
  };
}

describe("integrated RSGL i18n", () => {
  it("localizes RSGL contributions through the root package bundles", () => {
    const manifest = readJson<ExtensionManifest>("package.json");
    const defaultBundle = readJson<Record<string, string>>("package.nls.json");
    const zhBundle = readJson<Record<string, string>>("package.nls.zh-cn.json");
    const values: Array<{ label: string; value: string | undefined }> = [];

    for (const command of manifest.contributes?.commands ?? []) {
      if (command.command?.startsWith("rsgl.")) {
        values.push({ label: `${command.command} title`, value: command.title });
      }
    }
    for (const [key, contribution] of Object.entries(
      manifest.contributes?.configuration?.properties ?? {}
    )) {
      if (!key.startsWith("McResHelper.rsgl.")) {
        continue;
      }
      values.push({ label: `${key} description`, value: contribution.description });
      for (const [index, value] of (contribution.enumDescriptions ?? []).entries()) {
        values.push({ label: `${key} enumDescriptions[${index}]`, value });
      }
    }
    const validation = manifest.contributes?.jsonValidation?.find(entry =>
      entry.fileMatch === "**/rsgl.config.json"
    );
    values.push({ label: "RSGL schema URL", value: validation?.url });

    assert.ok(values.length >= 20, "root manifest should expose the complete localized RSGL surface");
    for (const { label, value } of values) {
      const key = packageNlsKey(value, label);
      assert.ok(defaultBundle[key]?.trim(), `${label} is missing from package.nls.json`);
      assert.ok(zhBundle[key]?.trim(), `${label} is missing from package.nls.zh-cn.json`);
      assert.notStrictEqual(zhBundle[key], defaultBundle[key], `${label} should be translated`);
    }
  });

  it("ships structurally aligned root-bundled English and Chinese RSGL schemas", () => {
    const manifest = readJson<ExtensionManifest>("package.json");
    const defaultBundle = readJson<Record<string, string>>("package.nls.json");
    const zhBundle = readJson<Record<string, string>>("package.nls.zh-cn.json");
    const registration = manifest.contributes?.jsonValidation?.find(entry =>
      entry.fileMatch === "**/rsgl.config.json"
    );
    const key = packageNlsKey(registration?.url, "RSGL schema URL");
    const enPath = resolveBundledPath(defaultBundle[key], "English RSGL schema");
    const zhPath = resolveBundledPath(zhBundle[key], "Chinese RSGL schema");

    assert.match(normalizeRelativePath(enPath), /\/schemas\/en\//);
    assert.match(normalizeRelativePath(zhPath), /\/schemas\/zh-cn\//);
    const enSchema = readJsonFile<unknown>(enPath);
    const zhSchema = readJsonFile<unknown>(zhPath);
    assert.deepStrictEqual(schemaStructure(zhSchema), schemaStructure(enSchema));

    const enStrings = collectSchemaLocalizedStrings(enSchema);
    const zhStrings = collectSchemaLocalizedStrings(zhSchema);
    assert.deepStrictEqual(zhStrings.map(item => item.location), enStrings.map(item => item.location));
    assert.ok(enStrings.length > 0);
    for (const item of enStrings) {
      assert.doesNotMatch(item.value, /[\u4e00-\u9fff]/, `English schema text at ${item.location}`);
    }
    for (const item of zhStrings) {
      assert.match(item.value, /[\u4e00-\u9fff]/, `Chinese schema text at ${item.location}`);
    }
  });

  it("keeps every static integrated-host message in the root runtime bundles", () => {
    const runtimeKeys = collectRsglRuntimeKeys();
    const defaultBundle = readJson<Record<string, string>>("l10n", "bundle.l10n.json");
    const zhBundle = readJson<Record<string, string>>("l10n", "bundle.l10n.zh-cn.json");

    assert.ok(runtimeKeys.size > 0, "integrated RSGL source should expose runtime UI strings");
    for (const key of runtimeKeys) {
      assert.strictEqual(defaultBundle[key], key, `default root runtime bundle is missing ${key}`);
      assert.ok(zhBundle[key]?.trim(), `Chinese root runtime bundle is missing ${key}`);
      assert.notStrictEqual(zhBundle[key], key, `${key} should be translated`);
      assert.deepStrictEqual(placeholders(zhBundle[key]), placeholders(key), `${key} placeholders`);
    }
    assert.deepStrictEqual(collectNonStaticRsglL10nCalls(), []);
  });
});

function collectRsglRuntimeKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of collectTypeScriptFiles(path.join(process.cwd(), "src", "rsgl"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/vscode\.l10n\.t\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      keys.add(unescapeStringLiteral(match[2]));
    }
  }
  return keys;
}

function collectNonStaticRsglL10nCalls(): string[] {
  const calls: string[] = [];
  for (const file of collectTypeScriptFiles(path.join(process.cwd(), "src", "rsgl"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/vscode\.l10n\.t\(\s*([^"'`{])/g)) {
      calls.push(`${path.relative(process.cwd(), file)}:${lineNumberAt(source, match.index ?? 0)}`);
    }
  }
  return calls.sort();
}

function packageNlsKey(value: string | undefined, label: string): string {
  const match = /^%([^%]+)%$/.exec(value ?? "");
  assert.ok(match, `${label} should use a package.nls placeholder`);
  return match[1];
}

function resolveBundledPath(value: string | undefined, label: string): string {
  assert.ok(value, `${label} path is missing`);
  const resolved = path.resolve(process.cwd(), value);
  const relative = path.relative(process.cwd(), resolved);
  assert.ok(
    relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `${label} escapes the extension root`
  );
  assert.ok(fs.existsSync(resolved), `${label} does not exist: ${resolved}`);
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

function readJson<T>(...segments: string[]): T {
  return readJsonFile<T>(path.join(process.cwd(), ...segments));
}

function readJsonFile<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
}

function unescapeStringLiteral(value: string): string {
  return value.replace(/\\([\\'"`])/g, "$1");
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split(/\r\n|\n|\r/).length;
}
