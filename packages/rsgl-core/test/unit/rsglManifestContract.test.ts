import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
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
    const grammarJson = JSON.parse(fs.readFileSync(path.join(rsglPackageRoot, grammar.path!), "utf8")) as unknown;
    for (const kind of rsglResourceKinds) {
      assert.ok(JSON.stringify(grammarJson).includes(kind), `Expected RSGL grammar to include resource kind '${kind}'.`);
    }
    for (const keyword of ["box", "element", "cullface", "mirror", "translate"]) {
      assert.ok(JSON.stringify(grammarJson).includes(keyword), `Expected RSGL grammar to include geometry keyword '${keyword}'.`);
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
