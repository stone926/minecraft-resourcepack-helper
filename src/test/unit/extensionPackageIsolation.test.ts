import * as assert from "node:assert";
import * as fs from "node:fs";
import { isBuiltin } from "node:module";
import * as path from "node:path";

describe("independent extension package isolation", () => {
  it("keeps rsgl-core out of the main VSIX and limits intentional duplication to mc-assets", () => {
    const root = process.cwd();
    const mainIgnore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");
    const rsglTsconfig = JSON.parse(
      fs.readFileSync(path.join(root, "extensions", "vscode-rsgl", "tsconfig.json"), "utf8")
    ) as { include?: string[] };
    const testRoot = path.join(root, "src", "test") + path.sep;
    const mainSources = listTypeScriptFiles(path.join(root, "src"))
      .filter(fileName => !fileName.startsWith(testRoot))
      .map(fileName => fs.readFileSync(fileName, "utf8"))
      .join("\n");

    assert.match(mainIgnore, /^out\/packages\/\*\*$/m);
    assert.match(mainIgnore, /^!out\/packages\/mc-assets\/src\/\*\*\/\*\.js$/m);
    assert.strictEqual(mainIgnore.includes("!out/packages/rsgl-core"), false);
    assert.strictEqual(mainSources.includes("packages/rsgl-core"), false);
    assert.ok(rsglTsconfig.include?.includes("../../packages/mc-assets/src/**/*.ts"));
    assert.ok(rsglTsconfig.include?.includes("../../packages/rsgl-core/src/**/*.ts"));
  });

  it("declares release-safe extension package metadata", () => {
    const root = process.cwd();
    const mainManifest = readJson<ExtensionManifest>(path.join(root, "package.json"));
    const rsglManifest = readJson<ExtensionManifest>(path.join(root, "extensions", "vscode-rsgl", "package.json"));

    assert.strictEqual(mainManifest.private, true);
    assert.strictEqual(rsglManifest.private, true);
    assert.strictEqual(mainManifest.license, "Unlicense");
    assert.strictEqual(rsglManifest.license, "Unlicense");
    assert.match(mainManifest.scripts?.["vscode:prepublish"] ?? "", /clean\.mjs out/);
    assert.match(rsglManifest.scripts?.["vscode:prepublish"] ?? "", /npm run compile/);
    assert.ok(rsglManifest.dependencies?.["@humanwhocodes/momoa"]);
    assert.ok(fs.existsSync(path.join(root, "extensions", "vscode-rsgl", "LICENSE")));

    for (const packageName of ["mc-assets", "rsgl-cli", "rsgl-core", "rsgl-lsp", "rsgl-shared"]) {
      const manifest = readJson<ExtensionManifest>(path.join(root, "packages", packageName, "package.json"));
      assert.strictEqual(manifest.private, true, `${packageName} must not be published as a broken package boundary`);
      assert.strictEqual(manifest.license, "Unlicense");
    }
  });

  it("declares every external module required by each compiled VSIX surface", () => {
    const root = process.cwd();
    const mainManifest = readJson<ExtensionManifest>(path.join(root, "package.json"));
    const rsglManifest = readJson<ExtensionManifest>(path.join(root, "extensions", "vscode-rsgl", "package.json"));
    const mainDependencies = compiledExternalDependencies([
      path.join(root, "out", "src"),
      path.join(root, "out", "packages", "mc-assets", "src")
    ], [path.join(root, "out", "src", "test")]);
    const rsglDependencies = compiledExternalDependencies([
      path.join(root, "out", "extensions", "vscode-rsgl", "src"),
      path.join(root, "out", "packages", "mc-assets", "src"),
      path.join(root, "out", "packages", "rsgl-core", "src"),
      path.join(root, "out", "packages", "rsgl-lsp", "src"),
      path.join(root, "out", "packages", "rsgl-shared", "src")
    ]);

    assert.deepStrictEqual(
      missingManifestDependencies(mainDependencies, mainManifest),
      [],
      "main VSIX has undeclared runtime dependencies"
    );
    assert.deepStrictEqual(
      missingManifestDependencies(rsglDependencies, rsglManifest),
      [],
      "RSGL VSIX has undeclared runtime dependencies"
    );
  });
});

interface ExtensionManifest {
  private?: boolean;
  license?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function readJson<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(fileName, "utf8")) as T;
}

function compiledExternalDependencies(directories: readonly string[], excludedDirectories: readonly string[] = []): Set<string> {
  const dependencies = new Set<string>();
  const excluded = excludedDirectories.map(directory => path.resolve(directory) + path.sep);
  for (const directory of directories) {
    for (const fileName of listJavaScriptFiles(directory)) {
      const absoluteFileName = path.resolve(fileName);
      if (excluded.some(prefix => absoluteFileName.startsWith(prefix))) {
        continue;
      }
      const source = fs.readFileSync(fileName, "utf8");
      for (const match of source.matchAll(/\brequire(?:\.resolve)?\(\s*["']([^"']+)["']\s*\)/g)) {
        const specifier = match[1];
        if (
          specifier === "vscode"
          || specifier.startsWith(".")
          || path.isAbsolute(specifier)
          || isBuiltin(specifier)
        ) {
          continue;
        }
        dependencies.add(packageNameFromSpecifier(specifier));
      }
    }
  }
  return dependencies;
}

function missingManifestDependencies(dependencies: ReadonlySet<string>, manifest: ExtensionManifest): string[] {
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  return [...dependencies].filter(dependency => !declared.has(dependency)).sort();
}

function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fileName = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(fileName));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fileName);
    }
  }
  return files;
}

function listJavaScriptFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fileName = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJavaScriptFiles(fileName));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fileName);
    }
  }
  return files;
}
