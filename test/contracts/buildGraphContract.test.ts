import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("repository build graph", () => {
  it("keeps production and test projects in explicit project-reference graphs", () => {
    const root = process.cwd();
    const solution = readJson<TsConfig>(path.join(root, "tsconfig.json"));
    const main = readJson<TsConfig>(path.join(root, "tsconfig.main.json"));
    const tests = readJson<TsConfig>(path.join(root, "tsconfig.tests.json"));

    assert.deepStrictEqual(main.include, ["src/**/*.ts"]);
    assert.deepStrictEqual(main.exclude, ["src/test/**"]);
    assert.deepStrictEqual(referencePaths(main), ["./packages/mc-assets"]);
    assert.ok(referencePaths(solution).includes("./tsconfig.main.json"));
    assert.ok(referencePaths(solution).includes("./tsconfig.tests.json"));
    assert.ok(tests.include?.includes("extensions/*/test/**/*.ts"));
    assert.ok(tests.include?.includes("test/**/*.ts"));

    for (const project of ["mc-assets", "rsgl-core", "rsgl-shared", "rsgl-lsp", "rsgl-cli"]) {
      const config = readJson<TsConfig>(path.join(root, "packages", project, "tsconfig.json"));
      assert.deepStrictEqual(config.include, ["src/**/*.ts"], `${project} must own only its source files`);
      assert.ok(config.compilerOptions?.tsBuildInfoFile?.includes(project));
    }
  });

  it("runs every owned test suite and bundles each distributable entry point", () => {
    const root = process.cwd();
    const manifest = readJson<{ scripts?: Record<string, string>; main?: string }>(path.join(root, "package.json"));
    const testCommand = manifest.scripts?.test ?? "";

    assert.strictEqual(manifest.main, "./bundle/extension.js");
    assert.ok(testCommand.includes("out/src/test"));
    assert.ok(testCommand.includes("out/packages/**/test"));
    assert.ok(testCommand.includes("out/extensions/**/test"));
    assert.ok(testCommand.includes("out/test"));
    assert.strictEqual(manifest.scripts?.["build:rsgl-cli"],
      "npm run typecheck:rsgl-cli && npm run bundle:rsgl-cli");
    assert.strictEqual(manifest.scripts?.["package:rsgl-cli"], "node scripts/package-rsgl-cli.mjs");

    const bundleScript = fs.readFileSync(path.join(root, "scripts", "build-bundles.mjs"), "utf8");
    for (const entryPoint of [
      "src/extension.ts",
      "extensions/vscode-rsgl/src/extension.ts",
      "packages/rsgl-lsp/src/server.ts",
      "extensions/vscode-rsgl/src/commands/buildWorker.ts",
      "packages/rsgl-cli/src/main.ts"
    ]) {
      assert.ok(bundleScript.includes(entryPoint), `missing bundle entry point ${entryPoint}`);
    }
    assert.ok(bundleScript.includes('sourcemap: "external"'));
    assert.ok(bundleScript.includes('target: "node20"'), "CLI bundle must honor its Node 20 engine floor");

    const vsixScript = fs.readFileSync(path.join(root, "scripts", "package-vsix.mjs"), "utf8");
    assert.ok(vsixScript.includes("SOURCE_DATE_EPOCH"));
    assert.ok(vsixScript.includes('"--format=%ct"'));
    assert.match(vsixScript, /env: \{ \.\.\.process\.env, SOURCE_DATE_EPOCH: sourceDateEpoch \}/);

    const budgets = readJson<{ coldActivationMilliseconds?: Record<string, number> }>(
      path.join(root, "scripts", "build-budgets.json")
    );
    assert.ok((budgets.coldActivationMilliseconds?.main ?? 0) > 0);
    assert.ok((budgets.coldActivationMilliseconds?.rsgl ?? 0) > 0);
  });
});

interface TsConfig {
  compilerOptions?: { tsBuildInfoFile?: string };
  include?: string[];
  exclude?: string[];
  references?: Array<{ path?: string }>;
}

function referencePaths(config: TsConfig): string[] {
  return config.references?.map(reference => reference.path ?? "") ?? [];
}

function readJson<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(fileName, "utf8")) as T;
}
