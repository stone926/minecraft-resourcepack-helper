import * as assert from "node:assert";
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
      ["scripts/package-vsix.mjs", "main", "--out", "dist/main.vsix"]
    ]);
    assert.deepStrictEqual(commands(artifact.createArtifactPlan("package", "rsgl", ["--out=dist/rsgl.vsix"])), [
      ["scripts/package-vsix.mjs", "rsgl", "--out=dist/rsgl.vsix"]
    ]);
    assert.deepStrictEqual(commands(artifact.createArtifactPlan("package", "rsgl-cli")), [
      ["scripts/package-rsgl-cli.mjs"]
    ]);
  });

  it("runs each product's runtime and budget checks in a deterministic order", () => {
    const spacedPath = "dist/release artifacts/main.vsix";
    assert.deepStrictEqual(commands(artifact.createArtifactPlan("verify", "main", [spacedPath])), [
      ["scripts/verify-build-budgets.mjs", "--target", "main", "--artifact", spacedPath]
    ]);
    assert.deepStrictEqual(commands(artifact.createArtifactPlan("verify", "rsgl", ["dist/rsgl.vsix"])), [
      ["scripts/verify-rsgl-vsix.mjs", "dist/rsgl.vsix"],
      ["scripts/verify-build-budgets.mjs", "--target", "rsgl", "--artifact", "dist/rsgl.vsix"]
    ]);
    assert.deepStrictEqual(commands(artifact.createArtifactPlan("verify", "rsgl-cli", ["dist/rsgl.tgz"])), [
      ["scripts/verify-rsgl-cli-package.mjs", "dist/rsgl.tgz"],
      ["scripts/verify-build-budgets.mjs", "--target", "rsgl-cli"]
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
    assert.strictEqual(calls[0].args[3], artifactPath);
  });

  it("stops verification when the first product check fails", () => {
    const calls: string[] = [];
    assert.throws(
      () => artifact.executeArtifactPlan(
        artifact.createArtifactPlan("verify", "rsgl", ["dist/rsgl.vsix"]),
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
    assert.deepStrictEqual(calls, ["scripts/verify-rsgl-vsix.mjs"]);
  });

  it("parses target-aware budget options without legacy aliases", () => {
    assert.deepStrictEqual(budget.parseBudgetArguments([]), {
      target: "all",
      artifactPath: undefined,
      bundleMode: "development"
    });
    assert.deepStrictEqual(
      budget.parseBudgetArguments(["--target", "main", "--artifact", "dist/main.vsix"]),
      { target: "main", artifactPath: "dist/main.vsix", bundleMode: "development" }
    );
    assert.deepStrictEqual(
      budget.parseBudgetArguments(["--artifact", "dist/rsgl.vsix", "--target", "rsgl"]),
      { target: "rsgl", artifactPath: "dist/rsgl.vsix", bundleMode: "development" }
    );
    assert.deepStrictEqual(budget.budgetTargets("all"), ["main", "rsgl", "rsgl-cli"]);
    assert.deepStrictEqual(budget.createBudgetPlan({ target: "main", artifactPath: "dist/main.vsix" }), [
      { target: "main", artifactPath: "dist/main.vsix", bundleMode: "development" }
    ]);
    assert.deepStrictEqual(budget.createBudgetPlan({ target: "rsgl-cli" }), [
      { target: "rsgl-cli", artifactPath: undefined, bundleMode: "development" }
    ]);
    assert.deepStrictEqual(
      budget.parseBudgetArguments(["--target", "main", "--bundle-mode=production"]),
      { target: "main", artifactPath: undefined, bundleMode: "production" }
    );
    assert.deepStrictEqual(
      budget.createBudgetPlan({ target: "rsgl-cli", bundleMode: "analyze" }),
      [{ target: "rsgl-cli", artifactPath: undefined, bundleMode: "analyze" }]
    );
    assert.throws(
      () => budget.parseBudgetArguments(["--target", "rsgl-cli", "--artifact", "cli.tgz"]),
      /requires --target main or --target rsgl/
    );
    assert.throws(
      () => budget.parseBudgetArguments(["--artifact", "all.zip"]),
      /requires --target main or --target rsgl/
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
