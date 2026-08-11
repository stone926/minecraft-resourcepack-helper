import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { rsglModelGeometryKeywordDescriptors } from "../../packages/rsgl-core/src/modelGeometrySyntax";
import { rsglResourceKinds } from "../../packages/rsgl-core/src/resourceKinds";

interface ExtensionManifest {
  activationEvents?: string[];
  extensionDependencies?: string[];
  extensionPack?: string[];
  contributes?: {
    commands?: Array<{ command?: string; icon?: string }>;
    languages?: Array<{ id?: string; extensions?: string[]; configuration?: string }>;
    grammars?: Array<{ language?: string; path?: string; scopeName?: string }>;
    menus?: Record<string, Array<{ command?: string; when?: string }>>;
    jsonValidation?: Array<{ fileMatch?: string; url?: string }>;
  };
}

describe("integrated RSGL manifest contract", () => {
  it("contributes the RSGL language, commands, and bundled editor assets from the root extension", () => {
    const manifest = readJson<ExtensionManifest>("package.json");

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
    assert.ok(language?.configuration);
    assert.doesNotThrow(() => readJson<unknown>(language!.configuration!));

    const grammar = manifest.contributes?.grammars?.find(entry => entry.language === "rsgl");
    assert.strictEqual(grammar?.scopeName, "source.rsgl");
    assert.ok(grammar?.path);
    const grammarJson = readJson<{
      repository?: {
        properties?: {
          patterns?: Array<{ name?: string; match?: string }>;
        };
      };
    }>(grammar!.path!);
    const grammarText = JSON.stringify(grammarJson);
    for (const kind of rsglResourceKinds) {
      assert.ok(grammarText.includes(kind), `Expected RSGL grammar to include resource kind '${kind}'.`);
    }
    const geometryPropertyRule = grammarJson.repository?.properties?.patterns?.find(
      pattern => pattern.name === "variable.other.property.rsgl"
    );
    assert.strictEqual(typeof geometryPropertyRule?.match, "string");
    const geometryPropertyPattern = new RegExp(`^(?:${geometryPropertyRule!.match})$`);
    for (const descriptor of rsglModelGeometryKeywordDescriptors) {
      assert.ok(grammarText.includes(descriptor.keyword),
        `Expected RSGL grammar to include geometry keyword '${descriptor.keyword}'.`);
      const isControlledTransformKeyword = "statement" in descriptor
        ? descriptor.statement.kind === "transform"
        : descriptor.roles.some(role => role === "transformOperation" || role === "transformClause");
      assert.strictEqual(
        geometryPropertyPattern.test(descriptor.keyword),
        !isControlledTransformKeyword,
        isControlledTransformKeyword
          ? `Expected controlled transform keyword '${descriptor.keyword}' to stay out of the generic property rule.`
          : `Expected RSGL grammar property rule to include geometry keyword '${descriptor.keyword}'.`
      );
    }

    const expectedCommands = new Map([
      ["rsgl.build", "$(play)"],
      ["rsgl.previewBuild", "$(diff)"],
      ["rsgl.buildDirectory", "$(run-all)"],
      ["rsgl.previewDirectoryBuild", "$(diff)"],
      ["rsgl.buildWorkspace", "$(run-all)"],
      ["rsgl.previewWorkspaceBuild", "$(diff)"],
      ["rsgl.refreshWorkspace", "$(sync)"]
    ]);
    for (const [commandId, icon] of expectedCommands) {
      assert.ok(manifest.contributes?.commands?.some(command =>
        command.command === commandId && command.icon === icon
      ), `missing root command ${commandId}`);
    }
    for (const command of ["rsgl.build", "rsgl.previewBuild", "rsgl.buildDirectory", "rsgl.previewDirectoryBuild"]) {
      assert.ok(manifest.contributes?.menus?.["editor/title"]?.some(item =>
        item.command === command && item.when === "resourceLangId == rsgl"
      ), `missing editor title menu for ${command}`);
      assert.ok(manifest.contributes?.menus?.["editor/context"]?.some(item =>
        item.command === command && item.when === "resourceLangId == rsgl"
      ), `missing editor context menu for ${command}`);
    }
  });

  it("registers a strict root-bundled schema for every public project configuration field", () => {
    const manifest = readJson<ExtensionManifest>("package.json");
    const registration = manifest.contributes?.jsonValidation?.find(entry =>
      entry.fileMatch === "**/rsgl.config.json"
    );
    assert.ok(registration?.url);

    const packageNls = readJson<Record<string, string>>("package.nls.json");
    const schemaUrl = resolvePackageNlsValue(registration!.url!, packageNls);
    const schema = readJson<{
      additionalProperties?: boolean;
      properties?: Record<string, {
        pattern?: string;
        minimum?: number;
        default?: number;
        $ref?: string;
      }>;
      definitions?: {
        target?: {
          additionalProperties?: boolean;
          required?: string[];
          properties?: {
            edition?: { const?: string };
            format?: {
              oneOf?: Array<{
                minimum?: number;
                minItems?: number;
                maxItems?: number;
                items?: Array<{ minimum?: number }>;
              }>;
            };
            mc?: { pattern?: string };
          };
          oneOf?: Array<{ required?: string[] }>;
        };
        externEntry?: {
          additionalProperties?: boolean;
          required?: string[];
          properties?: {
            source?: { enum?: string[] };
            kind?: { enum?: string[] };
          };
        };
      };
    }>(schemaUrl);

    assert.strictEqual(schema.additionalProperties, false);
    assert.deepStrictEqual(Object.keys(schema.properties ?? {}).sort(), [
      "checkExternExistence",
      "customResourcePackPaths",
      "defaultAssetsPath",
      "emitSourceMap",
      "extern",
      "manifest",
      "maxEvaluationItems",
      "maxItemModelDepth",
      "namespace",
      "outDir",
      "resourcePackRoots",
      "root",
      "target",
      "vanillaResourcePackPath"
    ]);

    const namespace = schema.properties?.namespace;
    assert.ok(namespace?.pattern);
    const namespacePattern = new RegExp(namespace.pattern);
    assert.strictEqual(namespacePattern.test("example.pack-1"), true);
    assert.strictEqual(namespacePattern.test("Example"), false);
    assert.strictEqual(namespacePattern.test(".."), false);
    assert.strictEqual(schema.properties?.maxEvaluationItems?.minimum, 1);
    assert.strictEqual(schema.properties?.maxEvaluationItems?.default, 100000);
    assert.strictEqual(schema.properties?.maxItemModelDepth?.minimum, 1);
    assert.strictEqual(schema.properties?.maxItemModelDepth?.default, 128);
    assert.strictEqual(schema.properties?.target?.$ref, "#/definitions/target");

    const target = schema.definitions?.target;
    assert.strictEqual(target?.additionalProperties, false);
    assert.deepStrictEqual(target?.required, ["edition"]);
    assert.strictEqual(target?.properties?.edition?.const, "java");
    assert.deepStrictEqual(target?.oneOf?.map(option => option.required), [["format"], ["mc"]]);
    assert.ok(target?.properties?.mc?.pattern);
    assert.strictEqual(new RegExp(target!.properties!.mc!.pattern!).test("1.21.4"), true);
    const formatOptions = target?.properties?.format?.oneOf;
    assert.strictEqual(formatOptions?.[0]?.minimum, 1);
    assert.strictEqual(formatOptions?.[1]?.minItems, 2);
    assert.strictEqual(formatOptions?.[1]?.maxItems, 2);
    assert.deepStrictEqual(formatOptions?.[1]?.items?.map(item => item.minimum), [1, 0]);

    const externEntry = schema.definitions?.externEntry;
    assert.strictEqual(externEntry?.additionalProperties, false);
    assert.deepStrictEqual(externEntry?.required, ["source", "kind", "patterns"]);
    assert.deepStrictEqual(externEntry?.properties?.source?.enum, ["local", "custom", "vanilla"]);
    assert.deepStrictEqual(externEntry?.properties?.kind?.enum, [
      "model",
      "blockstate",
      "item",
      "font",
      "texture",
      "texture_directory",
      "sound",
      "font_file",
      "shader_vertex",
      "shader_fragment"
    ]);
  });

  it("exposes only an asynchronous integrated runtime factory", () => {
    const hostRoot = path.join(process.cwd(), "src", "rsgl", "host");
    const host = fs.readFileSync(path.join(hostRoot, "rsglHost.ts"), "utf8");

    assert.strictEqual(fs.existsSync(path.join(hostRoot, "api.ts")), false);
    assert.match(host, /export function createRsglRuntime/);
    assert.strictEqual(host.includes("registerCommand"), false);
    assert.strictEqual(host.includes("export function activate"), false);
    assert.strictEqual(host.includes("RsglApi"), false);
    assert.strictEqual(host.includes("createRsglApi"), false);
  });

  it("offloads command builds to an explicitly located worker", () => {
    const hostRoot = path.join(process.cwd(), "src", "rsgl", "host");
    const presenter = fs.readFileSync(path.join(hostRoot, "commands", "buildPresenter.ts"), "utf8");
    const commands = fs.readFileSync(path.join(hostRoot, "commands", "build.ts"), "utf8");
    const workerClient = fs.readFileSync(path.join(hostRoot, "commands", "buildWorkerClient.ts"), "utf8");
    const host = fs.readFileSync(path.join(hostRoot, "rsglHost.ts"), "utf8");

    assert.strictEqual(presenter.includes("Promise.resolve(task())"), false);
    assert.match(presenter, /cancellable:\s*true/);
    assert.match(commands, /runRsglWorkerTask/);
    assert.match(commands, /workerPath:\s*paths\.workerPath/);
    assert.strictEqual(commands.includes("buildRsglResourcePackProgram"), false);
    assert.match(workerClient, /new Worker\(workerPath\)/);
    assert.strictEqual(workerClient.includes("__dirname"), false);
    assert.match(host, /import\("\.\/commands\/build\.js"\)/);
    assert.strictEqual(host.includes('from "./commands/build"'), false);
  });

  it("shares the RSGL file glob while keeping watcher responsibilities separate", () => {
    const client = fs.readFileSync(path.join(process.cwd(), "src", "rsgl", "host", "client.ts"), "utf8");
    const shared = fs.readFileSync(
      path.join(process.cwd(), "packages", "rsgl-shared", "src", "index.ts"),
      "utf8"
    );

    assert.match(shared, /rsglFileGlob\s*=\s*"\*\*\/\*\.rsgl"/);
    assert.match(client, /fileEvents:\s*\[/);
    assert.match(client, /vscode\.workspace\.createFileSystemWatcher\(rsglFileGlob\)/);
    assert.match(client, /synchronize:\s*\{/);
    assert.match(client, /new DependencyWatchRegistry/);
    assert.strictEqual(client.includes('createFileSystemWatcher("**/*.json")'), false);
    assert.match(shared, /refreshWorkspace:\s*"rsgl\.refreshWorkspace"/);
  });
});

function resolvePackageNlsValue(value: string, bundle: Record<string, string>): string {
  const match = /^%([^%]+)%$/.exec(value);
  if (!match) {
    return value;
  }
  const localized = bundle[match[1]];
  assert.ok(localized, `package.nls.json is missing ${match[1]}`);
  return localized;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), relativePath.replace(/^\.\//, "")),
    "utf8"
  )) as T;
}
