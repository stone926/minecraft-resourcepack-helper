import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  rsglModelGeometryKeywordDescriptors
} from "../../src/modelGeometrySyntax";
import { rsglResourceKinds } from "../../src/resourceKinds";

describe("RSGL extension manifest contract", () => {
  it("contributes the rsgl language and bundled editor assets", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      activationEvents?: string[];
      extensionDependencies?: string[];
      contributes?: {
        commands?: Array<{ command?: string; icon?: string }>;
        languages?: Array<{ id?: string; extensions?: string[]; configuration?: string }>;
        grammars?: Array<{ language?: string; path?: string; scopeName?: string }>;
        menus?: Record<string, Array<{ command?: string; when?: string }>>;
      };
    };
    const rsglPackageRoot = path.join(process.cwd(), "extensions", "vscode-rsgl");
    const rsglPackageJson = JSON.parse(fs.readFileSync(path.join(rsglPackageRoot, "package.json"), "utf8")) as typeof packageJson;
    const rsglConfigurationSurface = [
      "package.nls.json",
      "package.nls.zh-cn.json",
      path.join("src", "configuration.ts"),
      path.join("src", "client.ts")
    ].map(file => fs.readFileSync(path.join(rsglPackageRoot, file), "utf8")).join("\n");

    assert.strictEqual(packageJson.extensionDependencies?.includes("stone926.rsgl") ?? false, false);
    assert.strictEqual(packageJson.contributes?.languages?.some(entry => entry.id === "rsgl"), false);
    assert.strictEqual(rsglConfigurationSurface.includes("McResHelper."), false);
    for (const event of [
      "onCommand:McResHelper.buildRsglResourcePack",
      "onCommand:McResHelper.previewRsglResourcePackBuild",
      "onCommand:McResHelper.buildRsglResourcePackDirectory",
      "onCommand:McResHelper.previewRsglResourcePackDirectoryBuild",
      "onCommand:McResHelper.buildRsglWorkspaceResourcePacks",
      "onCommand:McResHelper.previewRsglWorkspaceResourcePackBuilds"
    ]) {
      assert.strictEqual(packageJson.activationEvents?.includes(event), false);
    }

    assert.ok(rsglPackageJson.activationEvents?.includes("onLanguage:rsgl"));
    assert.ok(rsglPackageJson.activationEvents?.includes("onCommand:rsgl.build"));
    assert.ok(rsglPackageJson.activationEvents?.includes("onCommand:rsgl.previewBuild"));
    assert.ok(rsglPackageJson.activationEvents?.includes("onCommand:rsgl.buildDirectory"));
    assert.ok(rsglPackageJson.activationEvents?.includes("onCommand:rsgl.previewDirectoryBuild"));
    assert.ok(rsglPackageJson.activationEvents?.includes("onCommand:rsgl.buildWorkspace"));
    assert.ok(rsglPackageJson.activationEvents?.includes("onCommand:rsgl.previewWorkspaceBuild"));

    const language = rsglPackageJson.contributes?.languages?.find(entry => entry.id === "rsgl");
    assert.ok(language);
    assert.ok(language.extensions?.includes(".rsgl"));
    assert.ok(language.configuration);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(rsglPackageRoot, language.configuration!), "utf8")));

    const grammar = rsglPackageJson.contributes?.grammars?.find(entry => entry.language === "rsgl");
    assert.strictEqual(grammar?.scopeName, "source.rsgl");
    assert.ok(grammar.path);
    const grammarJson = JSON.parse(fs.readFileSync(path.join(rsglPackageRoot, grammar.path!), "utf8")) as {
      repository?: {
        properties?: {
          patterns?: Array<{ name?: string; match?: string }>;
        };
      };
    };
    for (const kind of rsglResourceKinds) {
      assert.ok(JSON.stringify(grammarJson).includes(kind), `Expected RSGL grammar to include resource kind '${kind}'.`);
    }
    const geometryPropertyRule = grammarJson.repository?.properties?.patterns?.find(
      pattern => pattern.name === "variable.other.property.rsgl"
    );
    assert.strictEqual(typeof geometryPropertyRule?.match, "string");
    const geometryPropertyPattern = new RegExp(`^(?:${geometryPropertyRule!.match})$`);
    const grammarText = JSON.stringify(grammarJson);
    for (const descriptor of rsglModelGeometryKeywordDescriptors) {
      assert.ok(grammarText.includes(descriptor.keyword), `Expected RSGL grammar to include geometry keyword '${descriptor.keyword}'.`);
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

    for (const command of [
      "McResHelper.buildRsglResourcePack",
      "McResHelper.previewRsglResourcePackBuild",
      "McResHelper.buildRsglResourcePackDirectory",
      "McResHelper.previewRsglResourcePackDirectoryBuild",
      "McResHelper.buildRsglWorkspaceResourcePacks",
      "McResHelper.previewRsglWorkspaceResourcePackBuilds"
    ]) {
      assert.strictEqual(packageJson.contributes?.commands?.some(entry => entry.command === command), false);
    }

    assert.ok(rsglPackageJson.contributes?.commands?.some(command =>
      command.command === "rsgl.build" && command.icon === "$(play)"
    ));
    assert.ok(rsglPackageJson.contributes?.commands?.some(command =>
      command.command === "rsgl.previewBuild" && command.icon === "$(diff)"
    ));
    assert.ok(rsglPackageJson.contributes?.commands?.some(command =>
      command.command === "rsgl.buildDirectory" && command.icon === "$(run-all)"
    ));
    assert.ok(rsglPackageJson.contributes?.commands?.some(command =>
      command.command === "rsgl.previewDirectoryBuild" && command.icon === "$(diff)"
    ));
    assert.ok(rsglPackageJson.contributes?.commands?.some(command =>
      command.command === "rsgl.buildWorkspace" && command.icon === "$(run-all)"
    ));
    assert.ok(rsglPackageJson.contributes?.commands?.some(command =>
      command.command === "rsgl.previewWorkspaceBuild" && command.icon === "$(diff)"
    ));
    assert.ok(rsglPackageJson.contributes?.menus?.["editor/title"]?.some(item =>
      item.command === "rsgl.build" && item.when === "resourceLangId == rsgl"
    ));
    assert.ok(rsglPackageJson.contributes?.menus?.["editor/title"]?.some(item =>
      item.command === "rsgl.previewBuild" && item.when === "resourceLangId == rsgl"
    ));
    assert.ok(rsglPackageJson.contributes?.menus?.["editor/context"]?.some(item =>
      item.command === "rsgl.buildDirectory" && item.when === "resourceLangId == rsgl"
    ));
    assert.ok(rsglPackageJson.contributes?.menus?.["editor/context"]?.some(item =>
      item.command === "rsgl.previewDirectoryBuild" && item.when === "resourceLangId == rsgl"
    ));
  });

  it("registers a strict schema for every public project configuration field", () => {
    const rsglPackageRoot = path.join(process.cwd(), "extensions", "vscode-rsgl");
    const packageJson = JSON.parse(fs.readFileSync(path.join(rsglPackageRoot, "package.json"), "utf8")) as {
      contributes?: {
        jsonValidation?: Array<{ fileMatch?: string; url?: string }>;
      };
    };
    const registration = packageJson.contributes?.jsonValidation?.find(entry =>
      entry.fileMatch === "**/rsgl.config.json"
    );
    assert.ok(registration?.url);

    const schemaPath = path.resolve(rsglPackageRoot, registration.url);
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
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
                type?: string;
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
            kind?: { enum?: string[] };
          };
        };
      };
    };

    assert.strictEqual(schema.additionalProperties, false);
    assert.deepStrictEqual(Object.keys(schema.properties ?? {}).sort(), [
      "checkExternExistence",
      "defaultAssetsPath",
      "emitSourceMap",
      "extern",
      "manifest",
      "maxEvaluationItems",
      "namespace",
      "outDir",
      "resourcePackRoots",
      "root",
      "target"
    ]);

    const namespace = schema.properties?.namespace;
    assert.ok(namespace?.pattern);
    const namespacePattern = new RegExp(namespace.pattern);
    assert.strictEqual(namespacePattern.test("example.pack-1"), true);
    assert.strictEqual(namespacePattern.test("Example"), false);
    assert.strictEqual(namespacePattern.test(".."), false);

    assert.strictEqual(schema.properties?.maxEvaluationItems?.minimum, 1);
    assert.strictEqual(schema.properties?.maxEvaluationItems?.default, 100000);
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

  it("exposes an honest synchronous extension API contract", () => {
    const apiSource = fs.readFileSync(
      path.join(process.cwd(), "extensions", "vscode-rsgl", "src", "api.ts"),
      "utf8"
    );
    const sharedSource = fs.readFileSync(path.join(process.cwd(), "packages", "rsgl-shared", "src", "index.ts"), "utf8");

    assert.strictEqual(apiSource.includes("Promise.resolve("), false);
    assert.match(apiSource, /compileFile\(uri: vscode\.Uri, options\?: RsglApiCompileOptions\): RsglApiCompileResult/);
    assert.match(apiSource, /compileWorkspace\(workspace: vscode\.Uri, options\?: RsglApiCompileOptions\): RsglApiCompileResult/);
    assert.match(apiSource, /checkWorkspace\(workspace: vscode\.Uri, options\?: RsglApiCheckOptions\): RsglApiCheckResult/);
    assert.strictEqual(apiSource.includes("apiVersion"), false);
    assert.strictEqual(sharedSource.includes("rsglApiVersion"), false);
  });

  it("offloads command and watcher builds from the extension host", () => {
    const extensionRoot = path.join(process.cwd(), "extensions", "vscode-rsgl", "src");
    const presenterSource = fs.readFileSync(path.join(extensionRoot, "commands", "buildPresenter.ts"), "utf8");
    const commandSource = fs.readFileSync(path.join(extensionRoot, "commands", "build.ts"), "utf8");
    const workerClientSource = fs.readFileSync(path.join(extensionRoot, "commands", "buildWorkerClient.ts"), "utf8");
    const apiSource = fs.readFileSync(path.join(extensionRoot, "api.ts"), "utf8");

    assert.strictEqual(presenterSource.includes("Promise.resolve(task())"), false);
    assert.match(presenterSource, /cancellable:\s*true/);
    assert.match(commandSource, /runRsglWorkerTask/);
    assert.strictEqual(commandSource.includes("buildRsglResourcePackProgram"), false);
    assert.match(workerClientSource, /new Worker\(/);
    assert.match(apiSource, /kind:\s*"compileDirectory"/);
    assert.strictEqual(apiSource.includes("onDidCompile?.(compileWorkspace("), false);
  });

  it("shares the RSGL file glob while keeping watcher responsibilities separate", () => {
    const extensionRoot = path.join(process.cwd(), "extensions", "vscode-rsgl", "src");
    const clientSource = fs.readFileSync(path.join(extensionRoot, "client.ts"), "utf8");
    const apiSource = fs.readFileSync(path.join(extensionRoot, "api.ts"), "utf8");
    const fallbackSource = fs.readFileSync(path.join(extensionRoot, "languageFeatures.ts"), "utf8");
    const sharedSource = fs.readFileSync(
      path.join(process.cwd(), "packages", "rsgl-shared", "src", "index.ts"),
      "utf8"
    );

    assert.match(sharedSource, /rsglFileGlob\s*=\s*"\*\*\/\*\.rsgl"/);
    assert.match(clientSource, /fileEvents:\s*\[/);
    assert.match(clientSource, /vscode\.workspace\.createFileSystemWatcher\(rsglFileGlob\)/);
    assert.match(clientSource, /vscode\.workspace\.createFileSystemWatcher\("\*\*\/\*\.json"\)/);
    assert.match(apiSource, /new vscode\.RelativePattern\(workspace\.fsPath, rsglFileGlob\)/);
    assert.match(apiSource, /new vscode\.RelativePattern\(workspace\.fsPath, "\*\*\/\*\.json"\)/);
    assert.match(apiSource, /const dependencyPath = normalizeDependencyPath\(uri\.fsPath\)/);
    assert.match(apiSource, /dependencyPaths\.has\(dependencyPath\)/);
    assert.match(clientSource, /synchronize:\s*\{/);
    assert.match(apiSource, /const scheduleCompile/);
    assert.strictEqual(fallbackSource.includes("createFileSystemWatcher"), false);
  });
});
