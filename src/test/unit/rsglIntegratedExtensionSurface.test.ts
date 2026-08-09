import { rsglConfigKeys } from "../../../packages/rsgl-shared/src";
import { resourceConfigurationKeys } from "../../utils/resourceConfigurationKeys";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

interface ExtensionManifest {
  activationEvents?: string[];
  extensionDependencies?: string[];
  extensionPack?: string[];
  contributes?: {
    commands?: Array<{ command?: string }>;
    configuration?: {
      properties?: Record<string, {
        type?: string;
        enum?: string[];
        default?: unknown;
        minimum?: number;
        maximum?: number;
        scope?: string;
      }>;
    };
    configurationDefaults?: Record<string, Record<string, unknown>>;
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
    const lazyRegistration = readSource("src", "rsgl", "registerLazyRsglSubsystem.ts");
    const subsystemLoader = readSource("src", "rsgl", "loadInstalledRsglSubsystem.ts");
    const loader = readSource("src", "rsgl", "runtime", "loadInstalledRsglRuntime.ts");
    const host = readSource("src", "rsgl", "host", "rsglHost.ts");

    assert.ok(registration.includes("createInstalledRsglRuntimeLoader(context, options.runtimeModuleImporter, {"));
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
    assert.ok(lazyRegistration.includes("createInstalledRsglSubsystemLoader(context)"));
    assert.ok(lazyRegistration.includes(
      'type RsglSubsystemRegistration = import("./registerRsglSubsystem.js")'
    ));
    assert.strictEqual(lazyRegistration.includes('await import("./registerRsglSubsystem.js")'), false);
    assert.ok(subsystemLoader.includes('asAbsolutePath("bundle/features/rsglHost.js")'));
    assert.ok(subsystemLoader.includes("return import(subsystemUrl)"));
    assert.ok(host.includes('import("../registerRsglSubsystem.js")'));
    assert.ok(host.includes("createRsglSubsystem"));
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

    assert.strictEqual(rsglConfigKeys.defaultAssetsPath, resourceConfigurationKeys.defaultAssetsPath);
    assert.strictEqual(rsglConfigKeys.resourcePackLoadOrder, resourceConfigurationKeys.resourcePackLoadOrder);
    assert.strictEqual(shared.includes('"rsgl.outDir"'), false);
    assert.ok(buildContexts.includes("loadRsglProjectConfigForSource"));
    assert.ok(buildContexts.includes("resolveRsglOutputPackRoot"));
    assert.strictEqual(buildContexts.includes("resolveConfiguredOutDir"), false);
  });

  it("replays identical preview semantic tokens before refreshing through the server", () => {
    const client = readSource("src", "rsgl", "host", "client.ts");

    assert.ok(client.includes("new RsglSemanticTokenReplayCache()"));
    assert.ok(client.includes("provideDocumentSemanticTokens: (document, token, next)"));
    assert.ok(client.includes("provideRsglSemanticTokens(semanticTokenReplayCache"));
    assert.ok(client.includes("createReplay: replay => new vscode.SemanticTokens"));
    assert.ok(client.includes("onDidOpenTextDocument"));
    assert.ok(client.includes("semanticTokenReplayCache.prepareOpen"));
    assert.ok(client.includes("onDidChangeVisibleTextEditors"));
    assert.ok(client.includes("claimImmediateRefresh"));
    assert.ok(client.includes("onDidChangeSemanticTokensEmitter"));
    assert.ok(client.includes("onDidChangeTextDocument"));
    assert.ok(client.includes("semanticTokenReplayCache.invalidateAll()"));
    assert.ok(client.includes("addedDependencyPaths.some(invalidatesRsglSemanticTokens)"));
    assert.ok(client.includes("if (semanticResolutionChanged)"));
    assert.ok(client.includes('path.basename(fileName).toLowerCase() === "rsgl.config.json"'));
  });

  it("bridges language-scoped formatting settings without waking semantic caches", () => {
    const configuration = readSource("src", "rsgl", "host", "configuration.ts");
    const client = readSource("src", "rsgl", "host", "client.ts");
    const serverCore = readSource("packages", "rsgl-lsp", "src", "serverCore.ts");
    const serverSettings = readSource(
      "packages",
      "rsgl-lsp",
      "src",
      "serverCoreSettings.ts"
    );
    const server = readSource("packages", "rsgl-lsp", "src", "server.ts");

    assert.ok(configuration.includes('languageId: "rsgl"'));
    assert.ok(configuration.includes("normalizeRsglFormattingConfiguration"));
    for (const key of ["style", "lineWidth", "braceStyle"]) {
      assert.ok(configuration.includes(`rsglConfigKeys.${key}`));
      assert.ok(client.includes(`event.affectsConfiguration(rsglConfigKeys.${key})`));
    }
    assert.ok(client.includes("formatting: configuredRsglFormatting()"));
    assert.ok(client.includes("formatting: configuredRsglFormatting(folder.uri)"));

    assert.ok(serverCore.includes('export * from "./serverCoreSettings"'));
    assert.ok(serverSettings.includes("validationSettingsFingerprint"));
    assert.ok(serverSettings.includes("Formatting is intentionally excluded"));
    assert.ok(serverSettings.includes("formattingConfigurationForSource"));
    assert.ok(server.includes("const validationChanged = validationSettingsFingerprint"));
    assert.ok(server.includes("if (!validationChanged)"));
    assert.ok(server.includes("params.options,"));
    assert.ok(server.includes("formattingConfigurationForSource(fileName, validationSettings)"));

    const handlerStart = server.indexOf("connection.onDidChangeConfiguration");
    const handlerEnd = server.indexOf("documents.onDidOpen", handlerStart);
    const handler = server.slice(handlerStart, handlerEnd);
    const styleOnlyGuard = handler.indexOf("if (!validationChanged)");
    assert.ok(styleOnlyGuard >= 0);
    for (const expensiveWork of [
      "replaceSemanticCache",
      "projectTargetCache.invalidateAll",
      "workspaceValidationCache.invalidateAll",
      "invalidateResourceAnalysisCache",
      "scheduleAllOpenDocuments"
    ]) {
      assert.ok(
        handler.indexOf(expensiveWork) > styleOnlyGuard,
        `${expensiveWork} must remain behind the validation-subset guard`
      );
    }
  });

  it("declares stable language-overridable RSGL formatting settings", () => {
    const manifest = readManifest();
    const properties = manifest.contributes?.configuration?.properties ?? {};
    const style = properties["McResHelper.rsgl.format.style"];
    const lineWidth = properties["McResHelper.rsgl.format.lineWidth"];
    const braceStyle = properties["McResHelper.rsgl.format.braceStyle"];

    assert.deepStrictEqual(style?.enum, ["canonical", "compact", "expanded"]);
    assert.strictEqual(style?.default, "canonical");
    assert.strictEqual(style?.scope, "language-overridable");
    assert.strictEqual(lineWidth?.type, "integer");
    assert.strictEqual(lineWidth?.default, 100);
    assert.strictEqual(lineWidth?.minimum, 40);
    assert.strictEqual(lineWidth?.maximum, 240);
    assert.strictEqual(lineWidth?.scope, "language-overridable");
    assert.deepStrictEqual(braceStyle?.enum, ["sameLine", "nextLine"]);
    assert.strictEqual(braceStyle?.default, "sameLine");
    assert.strictEqual(braceStyle?.scope, "language-overridable");
    assert.deepStrictEqual(
      manifest.contributes?.configurationDefaults?.["[rsgl]"],
      Object.fromEntries([
        ["editor.tabSize", 2],
        ["editor.insertSpaces", true]
      ])
    );
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
