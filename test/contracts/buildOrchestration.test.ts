import * as assert from "node:assert";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface NodeStep {
  label: string;
  script: string;
  args: readonly string[];
}

interface BuildModule {
  createBuildPlan(
    targetName: string,
    options?: {
      mode?: "build" | "typecheck" | "bundle";
      bundleMode?: "development" | "production" | "analyze";
    }
  ): readonly NodeStep[];
  executeBuildPlan(
    plan: readonly NodeStep[],
    options?: {
      executeStep?: (step: NodeStep, context: { repositoryRoot: string }) => void;
      logger?: { log(message: string): void };
    }
  ): void;
  parseBuildArguments(args: string[]): { targetName: string; mode: string; bundleMode: string };
}

describe("build orchestration", () => {
  let build: BuildModule;

  before(async () => {
    build = await import(pathToFileURL(path.join(
      process.cwd(),
      "scripts",
      "build.mjs"
    )).href) as BuildModule;
  });

  it("plans focused typecheck and bundle work without npm recursion", () => {
    assert.deepStrictEqual(stepCommands(build.createBuildPlan("main")), [
      ["node_modules/typescript/bin/tsc", "-b", "tsconfig.main.json"],
      ["scripts/build-bundles.mjs", "main", "--bundle-mode", "development"]
    ]);
    assert.deepStrictEqual(stepCommands(build.createBuildPlan("rsgl")), [
      ["node_modules/typescript/bin/tsc", "-b", "extensions/vscode-rsgl/tsconfig.json"],
      ["scripts/build-bundles.mjs", "rsgl", "--bundle-mode", "development"]
    ]);
    assert.deepStrictEqual(stepCommands(build.createBuildPlan("rsgl-cli")), [
      ["node_modules/typescript/bin/tsc", "-b", "packages/rsgl-cli/tsconfig.json"],
      ["scripts/build-bundles.mjs", "rsgl-cli", "--bundle-mode", "development"]
    ]);
  });

  it("preserves the all and test build semantics", () => {
    assert.deepStrictEqual(stepCommands(build.createBuildPlan("all")), [
      ["node_modules/typescript/bin/tsc", "-b", "tsconfig.json"],
      ["scripts/copy-rsgl-stdlib.mjs", "out"],
      ["scripts/build-bundles.mjs", "all", "--bundle-mode", "development"]
    ]);
    assert.deepStrictEqual(stepCommands(build.createBuildPlan("test")), [
      ["scripts/clean.mjs"],
      ["node_modules/typescript/bin/tsc", "-b", "tsconfig.tests.json"],
      ["scripts/copy-rsgl-stdlib.mjs", "out"]
    ]);
  });

  it("supports explicit typecheck-only and bundle-only plans", () => {
    assert.deepStrictEqual(stepCommands(build.createBuildPlan("all", { mode: "typecheck" })), [
      ["node_modules/typescript/bin/tsc", "-b", "tsconfig.json"],
      ["scripts/copy-rsgl-stdlib.mjs", "out"]
    ]);
    assert.deepStrictEqual(stepCommands(build.createBuildPlan("all", { mode: "bundle" })), [
      ["scripts/build-bundles.mjs", "all", "--bundle-mode", "development"]
    ]);
    assert.throws(
      () => build.createBuildPlan("test", { mode: "bundle" }),
      /does not produce a distributable bundle/
    );
  });

  it("validates CLI flags and executes each step with the repository root", () => {
    assert.throws(() => build.parseBuildArguments([]), /Usage:/);
    assert.deepStrictEqual(build.parseBuildArguments(["main", "--typecheck-only"]), {
      targetName: "main",
      mode: "typecheck",
      bundleMode: "development"
    });
    assert.deepStrictEqual(
      build.parseBuildArguments(["main", "--bundle-only", "--bundle-mode", "production"]),
      { targetName: "main", mode: "bundle", bundleMode: "production" }
    );
    assert.deepStrictEqual(
      stepCommands(build.createBuildPlan("all", { mode: "bundle", bundleMode: "analyze" })),
      [["scripts/build-bundles.mjs", "all", "--bundle-mode", "analyze"]]
    );
    assert.throws(
      () => build.parseBuildArguments(["main", "--typecheck-only", "--bundle-only"]),
      /cannot be combined/
    );
    assert.throws(() => build.parseBuildArguments(["main", "--unknown"]), /Unknown build flag/);
    assert.throws(
      () => build.parseBuildArguments(["main", "--bundle-mode", "invalid"]),
      /Unknown bundle mode/
    );
    assert.throws(
      () => build.parseBuildArguments(["main", "--typecheck-only", "--bundle-mode=production"]),
      /cannot be used with --typecheck-only/
    );
    assert.throws(() => build.createBuildPlan("unknown"), /Unknown build target/);

    const calls: Array<{ step: NodeStep; repositoryRoot: string }> = [];
    const plan = build.createBuildPlan("main", { mode: "bundle" });
    build.executeBuildPlan(plan, {
      executeStep: (step, context) => calls.push({ step, ...context }),
      logger: { log: () => undefined }
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].step.script, "scripts/build-bundles.mjs");
    assert.strictEqual(calls[0].repositoryRoot, process.cwd());
  });

  it("stops the build plan at the first failed leaf command", () => {
    const calls: string[] = [];
    assert.throws(
      () => build.executeBuildPlan(build.createBuildPlan("main"), {
        executeStep: step => {
          calls.push(step.script);
          throw new Error("leaf failed");
        },
        logger: { log: () => undefined }
      }),
      /leaf failed/
    );
    assert.deepStrictEqual(calls, ["node_modules/typescript/bin/tsc"]);
  });
});

function stepCommands(plan: readonly NodeStep[]): string[][] {
  return plan.map(step => [step.script, ...step.args]);
}
