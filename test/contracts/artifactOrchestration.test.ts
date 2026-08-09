import * as assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface NodeStep {
  label: string;
  script: string;
  args: readonly string[];
}

interface ArtifactModule {
  createArtifactPlan(command: string, targetName: string, args?: string[]): readonly NodeStep[];
  parseArtifactArguments(args: string[]): {
    command: string;
    targetName: string;
    commandArgs: string[];
  };
  executeArtifactPlan(
    plan: readonly NodeStep[],
    options?: {
      executeStep?: (step: NodeStep, context: { repositoryRoot: string }) => void;
      logger?: { log(message: string): void };
    }
  ): void;
}

interface BudgetModule {
  parseBudgetArguments(args: string[]): { target: string; artifactPath?: string; bundleMode: string };
  budgetTargets(target: string): string[];
  createBudgetPlan(options?: {
    target?: string;
    artifactPath?: string;
    bundleMode?: string;
  }): Array<{ target: string; artifactPath?: string; bundleMode: string }>;
}

describe("artifact orchestration", () => {
  let artifact: ArtifactModule;
  let budget: BudgetModule;

  before(async () => {
    artifact = await import(pathToFileURL(path.join(
      process.cwd(),
      "scripts",
      "artifact.mjs"
    )).href) as ArtifactModule;
    budget = await import(pathToFileURL(path.join(
      process.cwd(),
      "scripts",
      "verify-build-budgets.mjs"
    )).href) as BudgetModule;
  });

  it("dispatches packaging to stable format-specific leaf scripts", () => {
    assert.deepStrictEqual(commands(artifact.createArtifactPlan("package", "main", ["--out", "dist/main.vsix"])), [
      ["scripts/build.mjs", "main", "--bundle-mode", "production"],
      ["scripts/assemble-main-vsix-stage.mjs"],
      ["scripts/package-vsix.mjs", "main", "--out", "dist/main.vsix"]
    ]);
    assert.deepStrictEqual(commands(artifact.createArtifactPlan("package", "rsgl-cli")), [
      ["scripts/package-rsgl-cli.mjs"]
    ]);
  });

  it("runs each product's runtime and budget checks in a deterministic order", () => {
    const spacedPath = "dist/release artifacts/main.vsix";
    assert.deepStrictEqual(commands(artifact.createArtifactPlan("verify", "main", [spacedPath])), [
      ["scripts/verify-main-vsix.mjs", spacedPath],
      [
        "scripts/verify-build-budgets.mjs",
        "--target",
        "main",
        "--artifact",
        spacedPath,
        "--bundle-mode",
        "production"
      ]
    ]);
    assert.deepStrictEqual(commands(artifact.createArtifactPlan("verify", "rsgl-cli", ["dist/rsgl.tgz"])), [
      ["scripts/verify-rsgl-cli-package.mjs", "dist/rsgl.tgz"],
      [
        "scripts/verify-build-budgets.mjs",
        "--target",
        "rsgl-cli",
        "--bundle-mode",
        "production"
      ]
    ]);
  });

  it("rejects unsupported targets and ambiguous verification inputs", () => {
    assert.throws(() => artifact.parseArtifactArguments([]), /Usage:/);
    assert.deepStrictEqual(
      artifact.parseArtifactArguments(["package", "main", "--out", "dist/main.vsix"]),
      {
        command: "package",
        targetName: "main",
        commandArgs: ["--out", "dist/main.vsix"]
      }
    );
    assert.throws(() => artifact.createArtifactPlan("package", "all"), /Unknown artifact target/);
    assert.throws(() => artifact.createArtifactPlan("package", "rsgl"), /Unknown artifact target/);
    assert.throws(() => artifact.createArtifactPlan("publish", "main"), /Unknown artifact command/);
    assert.throws(
      () => artifact.createArtifactPlan("verify", "main", []),
      /exactly one artifact path/
    );
    assert.throws(
      () => artifact.createArtifactPlan("verify", "main", ["one", "two"]),
      /exactly one artifact path/
    );
    assert.throws(
      () => artifact.createArtifactPlan("verify", "main", [""]),
      /non-empty artifact path/
    );
  });

  it("keeps artifact paths as one argv value during execution", () => {
    const calls: NodeStep[] = [];
    const artifactPath = "dist/path with spaces/main.vsix";
    artifact.executeArtifactPlan(
      artifact.createArtifactPlan("verify", "main", [artifactPath]),
      {
        executeStep: step => calls.push(step),
        logger: { log: () => undefined }
      }
    );
    assert.strictEqual(calls[0].args[0], artifactPath);
    assert.strictEqual(calls[1].args[3], artifactPath);
  });

  it("stops combined verification when the runtime smoke fails", () => {
    const calls: string[] = [];
    assert.throws(
      () => artifact.executeArtifactPlan(
        artifact.createArtifactPlan("verify", "main", ["dist/main.vsix"]),
        {
          executeStep: step => {
            calls.push(step.script);
            throw new Error("runtime smoke failed");
          },
          logger: { log: () => undefined }
        }
      ),
      /runtime smoke failed/
    );
    assert.deepStrictEqual(calls, ["scripts/verify-main-vsix.mjs"]);
  });

  it("parses target-aware budget options without legacy aliases", () => {
    assert.deepStrictEqual(budget.parseBudgetArguments([]), {
      target: "all",
      artifactPath: undefined,
      bundleMode: "production"
    });
    assert.deepStrictEqual(
      budget.parseBudgetArguments(["--target", "main", "--artifact", "dist/main.vsix"]),
      { target: "main", artifactPath: "dist/main.vsix", bundleMode: "production" }
    );
    assert.deepStrictEqual(
      budget.parseBudgetArguments(["--artifact", "dist/main.vsix", "--target", "main"]),
      { target: "main", artifactPath: "dist/main.vsix", bundleMode: "production" }
    );
    assert.deepStrictEqual(budget.budgetTargets("all"), ["main", "rsgl-cli"]);
    assert.deepStrictEqual(budget.createBudgetPlan({ target: "main", artifactPath: "dist/main.vsix" }), [
      { target: "main", artifactPath: "dist/main.vsix", bundleMode: "production" }
    ]);
    assert.deepStrictEqual(budget.createBudgetPlan({ target: "rsgl-cli" }), [
      { target: "rsgl-cli", artifactPath: undefined, bundleMode: "production" }
    ]);
    assert.deepStrictEqual(
      budget.parseBudgetArguments(["--target", "main", "--bundle-mode=production"]),
      { target: "main", artifactPath: undefined, bundleMode: "production" }
    );
    assert.throws(
      () => budget.createBudgetPlan({ target: "rsgl-cli", bundleMode: "analyze" }),
      /supports production only/
    );
    assert.throws(
      () => budget.parseBudgetArguments(["--target", "rsgl-cli", "--artifact", "cli.tgz"]),
      /requires --target main/
    );
    assert.throws(
      () => budget.parseBudgetArguments(["--artifact", "all.zip"]),
      /requires --target main/
    );
    assert.throws(
      () => budget.parseBudgetArguments(["--target", "main", "--target", "rsgl"]),
      /only be specified once/
    );
    assert.throws(
      () => budget.parseBudgetArguments(["--artifact", "one.vsix", "--artifact", "two.vsix"]),
      /only be specified once/
    );
    assert.throws(() => budget.parseBudgetArguments(["--target"]), /Missing target/);
    assert.throws(() => budget.parseBudgetArguments(["--artifact"]), /Missing path/);
    assert.throws(() => budget.parseBudgetArguments(["--target", "unknown"]), /Unknown budget target/);
    assert.throws(() => budget.parseBudgetArguments(["--unknown"]), /Unknown argument/);
    assert.throws(
      () => budget.parseBudgetArguments(["--bundle-mode", "invalid"]),
      /Unknown bundle mode/
    );
    assert.throws(() => budget.parseBudgetArguments(["--main-vsix", "old.vsix"]), /Unknown argument/);
    assert.throws(
      () => budget.createBudgetPlan({ target: "main", artifactPath: "" }),
      /non-empty string/
    );
  });
});

function commands(plan: readonly NodeStep[]): string[][] {
  return plan.map(step => [step.script, ...step.args]);
}
