import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

interface ExtensionManifest {
  activationEvents?: string[];
  extensionDependencies?: string[];
  extensionPack?: string[];
  contributes?: {
    commands?: Array<{ command?: string }>;
    languages?: Array<{ id?: string; extensions?: string[]; configuration?: string }>;
    grammars?: Array<{ language?: string; path?: string; scopeName?: string }>;
    jsonValidation?: Array<{ fileMatch?: string; url?: string }>;
  };
}

describe("integrated RSGL extension surface", () => {
  it("keeps the RSGL language, commands, and editor assets in the root extension", () => {
    const manifest = readManifest();

    assert.strictEqual(
      fs.existsSync(path.join(process.cwd(), "extensions", "vscode-rsgl", "package.json")),
      false
    );
    assert.strictEqual(manifest.extensionPack?.includes("stone926.rsgl") ?? false, false);
    assert.strictEqual(manifest.extensionDependencies?.includes("stone926.rsgl") ?? false, false);
    for (const event of [
      "onLanguage:rsgl",
      "onCommand:rsgl.build",
      "onCommand:rsgl.previewBuild",
      "onCommand:rsgl.buildDirectory",
      "onCommand:rsgl.previewDirectoryBuild",
      "onCommand:rsgl.buildWorkspace",
      "onCommand:rsgl.previewWorkspaceBuild",
      "onCommand:rsgl.refreshWorkspace"
    ]) {
      assert.ok(manifest.activationEvents?.includes(event), `missing root activation event ${event}`);
    }

    const language = manifest.contributes?.languages?.find(entry => entry.id === "rsgl");
    assert.ok(language?.extensions?.includes(".rsgl"));
    assertBundledJson(language?.configuration, "RSGL language configuration");

    const grammar = manifest.contributes?.grammars?.find(entry => entry.language === "rsgl");
    assert.strictEqual(grammar?.scopeName, "source.rsgl");
    assertBundledJson(grammar?.path, "RSGL grammar");

    const commandIds = new Set(manifest.contributes?.commands?.map(command => command.command));
    for (const command of [
      "rsgl.build",
      "rsgl.previewBuild",
      "rsgl.buildDirectory",
      "rsgl.previewDirectoryBuild",
      "rsgl.buildWorkspace",
      "rsgl.previewWorkspaceBuild",
      "rsgl.refreshWorkspace"
    ]) {
      assert.ok(commandIds.has(command), `missing root command ${command}`);
    }
  });

  it("loads the integrated host, language client, and build commands lazily with installed paths", () => {
    const registration = readSource("src", "rsgl", "registerRsglSubsystem.ts");
    const loader = readSource("src", "rsgl", "runtime", "loadInstalledRsglRuntime.ts");
    const host = readSource("src", "rsgl", "host", "rsglHost.ts");

    assert.ok(registration.includes("createInstalledRsglRuntimeLoader(context, undefined, {"));
    assert.ok(registration.includes("onMaterializationInvalidation:"));
    assert.ok(registration.includes("resolveMaterializationProject,"));
    assert.ok(registration.includes("resolveResourceNavigation:"));
    assert.ok(registration.includes('import("./rsglGeneratedContributionBridge.js")'));
    assert.ok(registration.includes('import("./rsglResourceNavigationBridge.js")'));
    assert.ok(registration.includes("if (subsystemDisposed)"));
    assert.ok(registration.includes("disposed while its navigation bridge was loading"));
    assert.match(registration, /try\s*{\s*const generated = await getGeneratedBridge\(\)/);
    assert.strictEqual(
      registration.includes('from "./rsglGeneratedContributionBridge"'),
      false
    );
    assert.strictEqual(
      registration.includes('from "./rsglResourceNavigationBridge"'),
      false
    );
    assert.strictEqual(registration.includes('from "./host/'), false);
    assert.ok(loader.includes('path.join("bundle", "rsgl", "server.js")'));
    assert.ok(loader.includes('path.join("bundle", "rsgl", "worker.js")'));
    assert.ok(loader.includes('path.join("bundle", "rsgl", "stdlib")'));
    assert.ok(host.includes('import("./client.js")'));
    assert.ok(host.includes('import("./commands/build.js")'));
    assert.strictEqual(host.includes('from "./client"'), false);
    assert.strictEqual(host.includes('from "./commands/build"'), false);
  });

  it("keeps dependency watchers in the lazy host and project authority in shared configuration", () => {
    const client = readSource("src", "rsgl", "host", "client.ts");
    const buildContexts = readSource("src", "rsgl", "host", "commands", "buildContexts.ts");
    const shared = readSource("packages", "rsgl-shared", "src", "index.ts");

    assert.ok(client.includes("externalDependencyWatchers"));
    assert.ok(client.includes("patternDependencyWatchers"));
    assert.ok(client.includes("structuralDependencyWatchers"));
    assert.ok(client.includes("rsglDependencyStructureChangedNotification"));
    assert.strictEqual(client.includes('createFileSystemWatcher("**/*.json")'), false);

    assert.ok(shared.includes('defaultAssetsPath: "McResHelper.defaultMcAssetsPath"'));
    assert.ok(shared.includes('resourcePackLoadOrder: "McResHelper.resourcePackLoadOrder"'));
    assert.strictEqual(shared.includes('"rsgl.outDir"'), false);
    assert.ok(buildContexts.includes("loadRsglProjectConfigForSource"));
    assert.ok(buildContexts.includes("resolveRsglOutputPackRoot"));
    assert.strictEqual(buildContexts.includes("resolveConfiguredOutDir"), false);
  });

  it("publishes local, custom, and vanilla extern sources in root-bundled schemas and grammar", () => {
    for (const locale of ["en", "zh-cn"]) {
      const schema = readJson<{
        definitions: { externEntry: { properties: { source: { enum: string[] } } } };
      }>("schemas", locale, "rsgl-config.schema.json");
      assert.deepStrictEqual(
        schema.definitions.externEntry.properties.source.enum,
        ["local", "custom", "vanilla"]
      );
    }
    const grammar = readSource("syntaxes", "rsgl.tmLanguage.json");
    assert.ok(grammar.includes("\\\\b(local|custom|vanilla)\\\\b"));
  });
});

function readManifest(): ExtensionManifest {
  return readJson<ExtensionManifest>("package.json");
}

function assertBundledJson(relativePath: string | undefined, label: string): void {
  assert.ok(relativePath, `${label} path is missing`);
  assert.doesNotThrow(() => JSON.parse(readSource(relativePath!)), `${label} must be valid JSON`);
}

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readSource(...segments)) as T;
}

function readSource(...segments: string[]): string {
  const normalized = segments.length === 1 ? segments[0].replace(/^\.\//, "") : path.join(...segments);
  return fs.readFileSync(path.join(process.cwd(), normalized), "utf8");
}
