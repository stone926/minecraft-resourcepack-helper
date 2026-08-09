import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

describe("single extension package boundary", () => {
  const root = process.cwd();

  it("owns every VS Code surface from the root manifest", () => {
    const manifest = readJson<ExtensionManifest>(path.join(root, "package.json"));
    const hostConfig = readJson<Tsconfig>(path.join(root, "tsconfig.rsgl-host.json"));
    const mainConfig = readJson<Tsconfig>(path.join(root, "tsconfig.main.json"));

    assert.strictEqual(manifest.main, "./bundle/extension.js");
    assert.deepStrictEqual(manifest.extensionKind, ["workspace"]);
    assert.strictEqual(manifest.extensionPack, undefined);
    assert.strictEqual(manifest.extensionDependencies, undefined);
    assert.ok(manifest.contributes?.languages?.some(language => language.id === "rsgl"));
    assert.ok(manifest.contributes?.grammars?.some(grammar => grammar.language === "rsgl"));
    assert.ok(manifest.contributes?.commands?.some(command => command.command === "rsgl.build"));
    assert.strictEqual(fs.existsSync(path.join(root, "extensions", "vscode-rsgl", "package.json")), false);

    assert.deepStrictEqual(hostConfig.include, ["src/rsgl/host/**/*.ts"]);
    assert.ok(hostConfig.references?.some(reference => reference.path === "./packages/rsgl-core"));
    assert.ok(hostConfig.references?.some(reference => reference.path === "./packages/rsgl-shared"));
    assert.ok(mainConfig.exclude?.includes("src/rsgl/host/**"));
    assert.ok(mainConfig.references?.some(reference => reference.path === "./packages/rsgl-shared"));
  });

  it("declares release-safe package metadata for one VSIX and one CLI", () => {
    const manifest = readJson<ExtensionManifest>(path.join(root, "package.json"));
    assert.strictEqual(manifest.private, true);
    assert.strictEqual(manifest.license, "Unlicense");
    assert.match(
      manifest.scripts?.["vscode:prepublish"] ?? "",
      /scripts\/build\.mjs main --bundle-mode production$/
    );
    assert.strictEqual(manifest.scripts?.["package:rsgl:vsix"], undefined);
    assert.strictEqual(manifest.scripts?.["release:rsgl"], undefined);

    for (const packageName of [
      "mc-assets",
      "resource-project",
      "rsgl-core",
      "rsgl-lsp",
      "rsgl-shared"
    ]) {
      const packageManifest = readJson<ExtensionManifest>(path.join(
        root,
        "packages",
        packageName,
        "package.json"
      ));
      assert.strictEqual(packageManifest.private, true, `${packageName} must remain internal`);
      assert.strictEqual(packageManifest.license, "Unlicense");
      assert.strictEqual(packageManifest.main, undefined);
      assert.strictEqual(packageManifest.types, undefined);
      assert.strictEqual(packageManifest.bin, undefined);
    }

    const cli = readJson<ExtensionManifest>(path.join(root, "packages", "rsgl-cli", "package.json"));
    assert.notStrictEqual(cli.private, true);
    assert.strictEqual(cli.license, "Unlicense");
    assert.strictEqual(cli.engines?.node, ">=20");
    assert.strictEqual(cli.main, "dist/rsgl.js");
    assert.strictEqual(cli.bin?.rsgl, "dist/rsgl.js");
    assert.ok(cli.files?.includes("dist/**"));
    assert.match(cli.scripts?.prepack ?? "", /build\.mjs rsgl-cli --bundle-mode production$/);
    assert.strictEqual(cli.publishConfig?.access, "public");
    assert.strictEqual(cli.publishConfig?.provenance, true);
  });

  it("keeps production payloads bundle-owned instead of shipping node_modules", () => {
    const assembler = fs.readFileSync(path.join(root, "scripts", "assemble-main-vsix-stage.mjs"), "utf8");
    const packager = fs.readFileSync(path.join(root, "scripts", "package-vsix.mjs"), "utf8");
    assert.match(assembler, /delete manifest\.dependencies/);
    assert.match(assembler, /delete manifest\.devDependencies/);
    assert.match(packager, /mainVsixStageLayout\.root/);
    assert.match(packager, /--no-dependencies/);
  });
});

interface ExtensionManifest {
  private?: boolean;
  license?: string;
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  engines?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
  extensionKind?: string[];
  extensionPack?: string[];
  extensionDependencies?: string[];
  contributes?: {
    languages?: Array<{ id?: string }>;
    grammars?: Array<{ language?: string }>;
    commands?: Array<{ command?: string }>;
  };
  publishConfig?: {
    access?: string;
    provenance?: boolean;
  };
}

interface Tsconfig {
  include?: string[];
  exclude?: string[];
  references?: Array<{ path?: string }>;
}

function readJson<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(fileName, "utf8")) as T;
}
