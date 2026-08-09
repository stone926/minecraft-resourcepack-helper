import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { BuildOptions } from "esbuild";

describe("repository build graph", () => {
  it("keeps production and test projects in explicit project-reference graphs", () => {
    const root = process.cwd();
    const solution = readJson<TsConfig>(path.join(root, "tsconfig.json"));
    const main = readJson<TsConfig>(path.join(root, "tsconfig.main.json"));
    const rsglHost = readJson<TsConfig>(path.join(root, "tsconfig.rsgl-host.json"));
    const tests = readJson<TsConfig>(path.join(root, "tsconfig.tests.json"));

    assert.deepStrictEqual(main.include, ["src/**/*.ts"]);
    assert.deepStrictEqual(main.exclude, ["src/test/**", "src/rsgl/host/**"]);
    assert.deepStrictEqual(referencePaths(main), [
      "./packages/mc-assets",
      "./packages/resource-project",
      "./packages/rsgl-shared"
    ]);
    assert.deepStrictEqual(rsglHost.include, ["src/rsgl/host/**/*.ts"]);
    assert.deepStrictEqual(referencePaths(rsglHost), [
      "./tsconfig.main.json",
      "./packages/mc-assets",
      "./packages/rsgl-core",
      "./packages/rsgl-shared"
    ]);
    assert.ok(referencePaths(solution).includes("./tsconfig.main.json"));
    assert.ok(referencePaths(solution).includes("./tsconfig.rsgl-host.json"));
    assert.strictEqual(referencePaths(solution).includes("./extensions/vscode-rsgl"), false);
    assert.ok(referencePaths(solution).includes("./tsconfig.tests.json"));
    assert.strictEqual(tests.include?.some(pattern => pattern.startsWith("extensions/")) ?? false, false);
    assert.ok(tests.include?.includes("test/**/*.ts"));

    for (const project of ["mc-assets", "resource-project", "rsgl-core", "rsgl-shared", "rsgl-lsp", "rsgl-cli"]) {
      const config = readJson<TsConfig>(path.join(root, "packages", project, "tsconfig.json"));
      assert.deepStrictEqual(config.include, ["src/**/*.ts"], `${project} must own only its source files`);
      assert.ok(config.compilerOptions?.tsBuildInfoFile?.includes(project));
    }
  });

  it("runs every owned test suite through the canonical build surface", async () => {
    const root = process.cwd();
    const manifest = readJson<{ scripts?: Record<string, string>; main?: string }>(path.join(root, "package.json"));
    const testCommand = manifest.scripts?.test ?? "";
    const scripts = manifest.scripts ?? {};

    assert.strictEqual(manifest.main, "./bundle/extension.js");
    assert.ok(testCommand.includes("out/src/test"));
    assert.ok(testCommand.includes("out/packages/**/test"));
    assert.strictEqual(testCommand.includes("out/extensions"), false);
    assert.ok(testCommand.includes("out/test"));
    assert.deepStrictEqual(
      Object.keys(scripts).filter(name => name === "build" || name.startsWith("build:")).sort(),
      ["build", "build:main", "build:rsgl", "build:rsgl-cli", "build:test"]
    );
    assert.ok(Object.values(scripts)
      .filter(command => command.includes("scripts/build.mjs"))
      .every(command => !command.includes("npm run")));

    const bundles = await readBundleModule(root);
    assert.deepStrictEqual(bundles.bundleModes, ["development", "production", "analyze"]);
    assert.deepStrictEqual(bundles.bundleAnalysisOutputs, {
      directory: "dist/build-analysis",
      duplicateReport: "dist/build-analysis/duplicate-modules.json"
    });
    assert.deepStrictEqual(
      bundles.bundleTargetProfiles.main,
      ["root", "rsglHost", "server", "worker", "modelPreview"]
    );
    assert.deepStrictEqual(
      bundles.bundleTargetProfiles.all,
      ["root", "rsglHost", "server", "worker", "modelPreview", "cli"]
    );
    assert.deepStrictEqual(
      Object.fromEntries(Object.entries(bundles.bundleEntryDefinitions).map(([id, definition]) => [
        id,
        [definition.entryPoint, definition.outfile]
      ])),
      {
        root: ["src/extension.ts", "bundle/extension.js"],
        rsglHost: ["src/rsgl/host/rsglHost.ts", "bundle/features/rsglHost.js"],
        server: ["packages/rsgl-lsp/src/server.ts", "bundle/rsgl/server.js"],
        worker: ["src/rsgl/host/commands/buildWorker.ts", "bundle/rsgl/worker.js"],
        modelPreview: ["webviews/modelPreview/main.js", "bundle/model-preview.js"],
        cli: ["packages/rsgl-cli/src/main.ts", "packages/rsgl-cli/dist/rsgl.js"]
      }
    );
    for (const id of ["root", "rsglHost", "server", "worker"] as const) {
      assert.strictEqual(bundles.bundleEntryDefinitions[id].platform, "node");
      assert.strictEqual(bundles.bundleEntryDefinitions[id].format, "cjs");
    }
    assert.deepStrictEqual(bundles.bundleEntryDefinitions.root.singletonExternals, ["vscode"]);
    assert.deepStrictEqual(bundles.bundleEntryDefinitions.rsglHost.singletonExternals, ["vscode"]);
    for (const id of ["server", "worker", "modelPreview", "cli"] as const) {
      assert.deepStrictEqual(bundles.bundleEntryDefinitions[id].singletonExternals, []);
    }
    assert.deepStrictEqual(
      pickBuildEnvironment(bundles.bundleEntryDefinitions.modelPreview),
      { platform: "browser", format: "esm", target: "es2022", external: [] }
    );
    assert.strictEqual(bundles.bundleEntryDefinitions.cli.target, "node20");
    assert.strictEqual(bundles.bundleEntryDefinitions.cli.banner, "#!/usr/bin/env node");
    const development = bundles.createEsbuildOptions(
      bundles.bundleEntryDefinitions.modelPreview,
      "development"
    );
    const production = bundles.createEsbuildOptions(
      bundles.bundleEntryDefinitions.modelPreview,
      "production"
    );
    const analyze = bundles.createEsbuildOptions(
      bundles.bundleEntryDefinitions.modelPreview,
      "analyze"
    );
    assert.strictEqual(development.minify, false);
    assert.strictEqual(development.sourcemap, "external");
    assert.strictEqual(production.minify, true);
    assert.strictEqual(production.sourcemap, "external");
    assert.strictEqual(analyze.minify, true);
    assert.strictEqual(analyze.metafile, true);

    const vsixScript = fs.readFileSync(path.join(root, "scripts", "package-vsix.mjs"), "utf8");
    assert.ok(vsixScript.includes("SOURCE_DATE_EPOCH"));
    assert.ok(vsixScript.includes("readHeadCommitTimestamp"));
    const gitLibrary = fs.readFileSync(path.join(root, "scripts", "lib", "git.mjs"), "utf8");
    assert.ok(gitLibrary.includes('"--format=%ct"'));
    assert.match(vsixScript, /env: \{ \.\.\.process\.env, SOURCE_DATE_EPOCH: sourceDateEpoch \}/);

    const budgets = readJson<{
      coldActivationMilliseconds?: Record<string, number>;
      bundleBytes?: Record<string, Record<string, number>>;
    }>(
      path.join(root, "scripts", "build-budgets.json")
    );
    assert.ok((budgets.coldActivationMilliseconds?.root ?? 0) > 0);
    assert.ok((budgets.coldActivationMilliseconds?.rsglHost ?? 0) > 0);
    for (const mode of ["development", "production"]) {
      assert.deepStrictEqual(
        Object.keys(budgets.bundleBytes?.[mode] ?? {}).sort(),
        ["cli", "modelPreview", "root", "rsglHost", "server", "worker"]
      );
    }
  });

  it("produces a self-contained browser ESM model preview bundle from one npm Three package", async () => {
    const root = process.cwd();
    const bundles = await readBundleModule(root);
    const { build } = await import("esbuild");
    const result = await build(bundles.createEsbuildOptions(
      bundles.bundleEntryDefinitions.modelPreview,
      "production",
      { write: false, sourcemap: false, metafile: true }
    ));
    const output = result.outputFiles?.find(file => file.path.endsWith("model-preview.js"));
    assert.ok(output, "model preview build should return its browser entry");
    const source = output.text;
    assert.doesNotMatch(source, /\b(?:require|module\.exports)\s*[=(]/);
    assert.doesNotMatch(source, /\bfrom\s*["']three(?:\/|["'])/);
    assert.doesNotMatch(source, /\bimport\s*["']three(?:\/|["'])/);
    assert.strictEqual(source.includes("eval("), false);

    const inputs = Object.keys(result.metafile?.inputs ?? {});
    const threeInputs = inputs.filter(input => input.replaceAll("\\", "/").includes("node_modules/three/"));
    assert.ok(threeInputs.length > 0, "browser bundle should inline npm Three inputs");
    assert.strictEqual(inputs.some(input => input.includes("webviews/modelPreview/vendor")), false);
    const packageRoot = fs.realpathSync(path.join(root, "node_modules", "three"));
    for (const input of threeInputs) {
      const resolved = fs.realpathSync(path.resolve(root, input));
      assert.ok(resolved.startsWith(`${packageRoot}${path.sep}`), `unexpected Three input: ${resolved}`);
    }
    const lock = readJson<{ packages?: Record<string, { version?: string }> }>(path.join(root, "package-lock.json"));
    const manifest = readJson<{ version?: string }>(path.join(packageRoot, "package.json"));
    assert.strictEqual(manifest.version, lock.packages?.["node_modules/three"]?.version);
  });

  it("keeps the root bundle physically unreachable from RSGL implementation code", async () => {
    const root = process.cwd();
    const bundles = await readBundleModule(root);
    const { build } = await import("esbuild");
    const result = await build(bundles.createEsbuildOptions(
      bundles.bundleEntryDefinitions.root,
      "production",
      { write: false, sourcemap: false, metafile: true }
    ));
    const rsglInputs = Object.keys(result.metafile?.inputs ?? {})
      .map(input => input.replaceAll("\\", "/"))
      .filter(input => input.startsWith("src/rsgl/") || input.startsWith("packages/rsgl-"))
      .sort();

    assert.deepStrictEqual(rsglInputs, [
      "src/rsgl/loadInstalledRsglSubsystem.ts",
      "src/rsgl/registerLazyRsglSubsystem.ts",
      "src/rsgl/rsglActivationSignals.ts"
    ]);
    const output = result.outputFiles?.find(file => file.path.endsWith("extension.js"));
    assert.ok(output, "root build should return its CommonJS entry");
    assert.strictEqual(
      output.text.match(/require\("vscode"\)/g)?.length,
      1,
      "all static VS Code API imports should share one external module load"
    );
    assert.ok(
      Object.hasOwn(result.metafile?.inputs ?? {}, "singleton-external:vscode"),
      "the root metafile should retain the reviewed singleton boundary"
    );
    const subsystemLoader = result.metafile?.inputs["src/rsgl/loadInstalledRsglSubsystem.ts"];
    assert.ok(
      subsystemLoader?.imports.some(input =>
        input.path === "node:url"
          && input.kind === "dynamic-import"
          && input.external === true),
      "the installed feature URL helper must remain a native dynamic import"
    );

    const hostResult = await build(bundles.createEsbuildOptions(
      bundles.bundleEntryDefinitions.rsglHost,
      "production",
      { write: false, sourcemap: false, metafile: true }
    ));
    const unsharedHostResult = await build(bundles.createEsbuildOptions(
      bundles.bundleEntryDefinitions.rsglHost,
      "production",
      { write: false, sourcemap: false, plugins: [] }
    ));
    const hostOutput = hostResult.outputFiles?.find(file => file.path.endsWith("rsglHost.js"));
    const unsharedHostOutput = unsharedHostResult.outputFiles
      ?.find(file => file.path.endsWith("rsglHost.js"));
    assert.ok(hostOutput, "RSGL host build should return its CommonJS entry");
    assert.ok(unsharedHostOutput, "unshared RSGL host comparison should return its entry");
    assert.strictEqual(
      Object.keys(hostResult.metafile?.inputs ?? {})
        .some(input => input.replaceAll("\\", "/").startsWith("src/registration/")),
      false,
      "the lazy RSGL host must not pull in the root registration layer"
    );
    assert.ok(
      (hostOutput.text.match(/require\("vscode"\)/g)?.length ?? 0)
        < (unsharedHostOutput.text.match(/require\("vscode"\)/g)?.length ?? 0),
      "the feature host should also deduplicate its static VS Code API imports"
    );
  });
});

interface BundleEntryDefinition {
  entryPoint: string;
  outfile: string;
  platform: string;
  format: string;
  target: string;
  external: readonly string[];
  singletonExternals: readonly string[];
  banner?: string;
}

interface BundleModule {
  bundleModes: readonly string[];
  bundleAnalysisOutputs: { directory: string; duplicateReport: string };
  bundleEntryDefinitions: Record<string, BundleEntryDefinition>;
  bundleTargetProfiles: Record<string, readonly string[]>;
  createEsbuildOptions(
    definition: BundleEntryDefinition,
    bundleMode: string,
    overrides?: Record<string, unknown>
  ): BuildOptions;
}

interface TsConfig {
  compilerOptions?: { tsBuildInfoFile?: string };
  include?: string[];
  exclude?: string[];
  references?: Array<{ path?: string }>;
}

function referencePaths(config: TsConfig): string[] {
  return config.references?.map(reference => reference.path ?? "") ?? [];
}

async function readBundleModule(root: string): Promise<BundleModule> {
  return await import(pathToFileURL(path.join(root, "scripts", "build-bundles.mjs")).href) as BundleModule;
}

function pickBuildEnvironment(definition: BundleEntryDefinition) {
  return {
    platform: definition.platform,
    format: definition.format,
    target: definition.target,
    external: definition.external
  };
}

function readJson<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(fileName, "utf8")) as T;
}
