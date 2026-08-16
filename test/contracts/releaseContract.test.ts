import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getWorkflowJob,
  getWorkflowStep,
  getWorkflowTrigger,
  loadGitHubWorkflow,
  workflowRunSteps,
  type GitHubWorkflow,
  type LoadedWorkflow,
  type WorkflowJob,
  type WorkflowStep
} from "./helpers/githubWorkflow";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../helpers/testProcess";

describe("single-extension release contracts", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  const root = process.cwd();

  it("maps the combined VSIX and CLI tag namespaces to one product each", () => {
    const main = readJson<Manifest>(path.join(root, "package.json"));
    const cli = readJson<Manifest>(path.join(root, "packages", "rsgl-cli", "package.json"));

    assert.match(cli.version, /^\d+\.\d+\.\d+$/);
    assert.strictEqual(main.extensionPack, undefined);
    assert.strictEqual(main.extensionDependencies, undefined);

    const mainRelease = describeTag(`v${main.version}`);
    const cliRelease = describeTag(`rsgl-cli-v${cli.version}`);

    assert.deepStrictEqual(
      [mainRelease.product, cliRelease.product],
      ["main", "rsgl-cli"]
    );
    assert.strictEqual(mainRelease.asset_name, `${main.name}-${main.version}.vsix`);
    assert.strictEqual(mainRelease.marketplace_publisher, main.publisher);
    assert.strictEqual(mainRelease.marketplace_extension, main.name);
    assert.strictEqual(cliRelease.marketplace_publisher, undefined);
    assert.strictEqual(
      cliRelease.asset_name,
      `minecraft-resourcepack-helper-rsgl-cli-${cli.version}.tgz`
    );
    assert.strictEqual(cliRelease.publish_kind, "npm");
    for (const [changelogPath, currentVersion] of [[
      "packages/rsgl-cli/CHANGELOG.md", cli.version
    ]] as const) {
      const changelog = read(changelogPath);
      assert.match(changelog, /^## \[1\.0\.0\]/m, `${changelogPath} must retain its first release`);
      assert.match(
        changelog,
        new RegExp(`^## \\[${escapeRegExp(currentVersion)}\\]`, "m"),
        `${changelogPath} must describe its current manifest version`
      );
    }
  });

  it("exposes only the supported target-specific release and packaging entry points", () => {
    const manifest = readJson<Manifest>(path.join(root, "package.json"));
    const scripts = manifest.scripts ?? {};

    assert.deepStrictEqual(
      Object.keys(scripts).filter(name => name === "build" || name.startsWith("build:")).sort(),
      ["build", "build:main", "build:rsgl", "build:rsgl-cli", "build:test"]
    );
    assert.deepStrictEqual(
      Object.keys(scripts).filter(name => name.startsWith("package:")).sort(),
      ["package:main:vsix", "package:rsgl-cli"]
    );
    assert.deepStrictEqual(
      Object.keys(scripts).filter(name => name.startsWith("verify:")).sort(),
      [
        "verify:build-budgets",
        "verify:json-only-extension-host-budget",
        "verify:main:vsix",
        "verify:rsgl-cli",
        "verify:runtime-benchmarks"
      ]
    );
    const expectedArtifactScripts = {
      "package:main:vsix": "node scripts/artifact.mjs package main",
      "verify:main:vsix": "node scripts/artifact.mjs verify main",
      "package:rsgl-cli": "node scripts/artifact.mjs package rsgl-cli",
      "verify:rsgl-cli": "node scripts/artifact.mjs verify rsgl-cli"
    };
    for (const [name, command] of Object.entries(expectedArtifactScripts)) {
      assert.strictEqual(scripts[name], command, `${name} must retain the artifact orchestrator`);
    }
    assert.strictEqual(
      scripts["verify:build-budgets"],
      "node scripts/build.mjs all --bundle-only --bundle-mode production && "
        + "node scripts/verify-build-budgets.mjs --target all --bundle-mode production"
    );
    const expectedReleaseScripts = {
      "release:main": "node scripts/release.mjs main",
      "release:rsgl-cli": "node scripts/release.mjs rsgl-cli",
      "release:rsgl-cli:current": "node scripts/release.mjs rsgl-cli current"
    };
    assert.deepStrictEqual(
      Object.keys(scripts).filter(name => name.startsWith("release")).sort(),
      Object.keys(expectedReleaseScripts).sort()
    );
    for (const [name, command] of Object.entries(expectedReleaseScripts)) {
      assert.strictEqual(scripts[name], command);
    }

    for (const removed of [
      "compile:rsgl-extension",
      "compile",
      "compile:all",
      "compile:test",
      "package:vsix",
      "verify:vsix-budgets",
      "deploy",
      "push"
    ]) {
      assert.strictEqual(scripts[removed], undefined, `${removed} must not bypass canonical commands`);
    }
    assert.deepStrictEqual(
      Object.keys(scripts).filter(name => /^(?:compile(?::|$)|typecheck:|bundle:)/.test(name)),
      [],
      "legacy build aliases must not be reintroduced"
    );
  });

  it("uses official npm registry URLs in committed lockfiles", () => {
    for (const lockfile of [
      "package-lock.json",
      "tools/vsce-publisher/package-lock.json"
    ]) {
      const source = read(lockfile);
      assert.strictEqual(source.includes("registry.npmmirror.com"), false, lockfile);
      assert.ok(source.includes("https://registry.npmjs.org/"), lockfile);
    }
  });

  it("gates release builds on Ubuntu and Windows through one reusable workflow", () => {
    const ci = loadWorkflow("ci.yml");
    const reusable = loadWorkflow("verify-release.yml");
    const release = loadWorkflow("release.yml");
    const ciVerify = getWorkflowJob(ci.workflow, "verify");
    const releaseVerify = getWorkflowJob(release.workflow, "verify");
    const reusableVerify = getWorkflowJob(reusable.workflow, "verify");
    const reusableNode20 = getWorkflowJob(reusable.workflow, "rsgl_cli_node20");

    assert.strictEqual(ciVerify.uses, "./.github/workflows/verify-release.yml");
    assert.deepStrictEqual(ciVerify.with, { product: "all", upload_artifacts: true });
    assert.strictEqual(releaseVerify.uses, "./.github/workflows/verify-release.yml");
    assert.strictEqual(
      releaseVerify.with?.source_ref,
      "${{ needs.contract.outputs.commit }}"
    );
    const matrix = requireRecord(reusableVerify.strategy?.matrix, "verify strategy matrix");
    assert.deepStrictEqual(matrix.os, ["ubuntu-latest", "windows-latest"]);
    assert.strictEqual(reusableVerify["timeout-minutes"], 60);
    assert.strictEqual(reusableNode20["timeout-minutes"], 30);
    assert.strictEqual(getWorkflowJob(release.workflow, "contract")["timeout-minutes"], 10);
    assert.strictEqual(getWorkflowJob(release.workflow, "build")["timeout-minutes"], 45);
    assert.strictEqual(getWorkflowJob(release.workflow, "publish_marketplace")["timeout-minutes"], 20);
    assert.strictEqual(getWorkflowJob(release.workflow, "publish_cli")["timeout-minutes"], 20);

    const prepareRuntime = getWorkflowStep(
      reusable.workflow,
      "verify",
      "Prepare VS Code test runtime"
    );
    assert.strictEqual(
      prepareRuntime.if,
      "inputs.product == 'all' || inputs.product == 'main'"
    );
    assert.strictEqual(prepareRuntime.run, "node scripts/prepare-vscode-test-runtime.mjs");
    const reusableSteps = reusableVerify.steps ?? [];
    assert.ok(
      stepIndex(reusableSteps, "Install dependencies")
        < stepIndex(reusableSteps, "Prepare VS Code test runtime"),
      "VS Code runtime preparation requires the installed pinned downloader"
    );
    assert.ok(
      stepIndex(reusableSteps, "Prepare VS Code test runtime")
        < stepIndex(reusableSteps, "Verify main extension package"),
      "the Linux runtime must be exported before main VSIX verification"
    );

    assertSingleCommandStep(
      reusable.workflow,
      "verify",
      "Package main extension",
      "npm run package:main:vsix -- --out"
    );
    assertSingleCommandStep(
      reusable.workflow,
      "verify",
      "Verify main extension package",
      "npm run verify:main:vsix --"
    );
    assertSingleCommandStep(
      reusable.workflow,
      "verify",
      "Package RSGL CLI",
      "npm run package:rsgl-cli -- --out"
    );
    assertSingleCommandStep(
      reusable.workflow,
      "verify",
      "Verify RSGL CLI package",
      "npm run verify:rsgl-cli --"
    );
    assertSingleCommandStep(
      release.workflow,
      "build",
      "Package selected product",
      "node scripts/artifact.mjs package"
    );
    assertSingleCommandStep(
      release.workflow,
      "build",
      "Verify selected product",
      "node scripts/artifact.mjs verify"
    );
    const buildSteps = getWorkflowJob(release.workflow, "build").steps ?? [];
    const prepareBuildRuntime = getWorkflowStep(
      release.workflow,
      "build",
      "Prepare VS Code test runtime"
    );
    assert.strictEqual(prepareBuildRuntime.if, "needs.contract.outputs.product == 'main'");
    assert.strictEqual(
      prepareBuildRuntime.run,
      "node scripts/prepare-vscode-test-runtime.mjs"
    );
    assert.ok(
      stepIndex(buildSteps, "Install dependencies")
        < stepIndex(buildSteps, "Prepare VS Code test runtime"),
      "immutable main verification requires the installed pinned runtime downloader"
    );
    assert.ok(
      stepIndex(buildSteps, "Prepare VS Code test runtime")
        < stepIndex(buildSteps, "Verify selected product"),
      "the main release build must export VS Code before immutable artifact verification"
    );
    assert.ok(
      stepIndex(buildSteps, "Package selected product") < stepIndex(buildSteps, "Verify selected product"),
      "immutable artifact verification must follow packaging"
    );
    const releaseRuns = workflowRunSteps(release).map(step => step.run).join("\n");
    const reusableRuns = workflowRunSteps(reusable).map(step => step.run).join("\n");
    assert.strictEqual(releaseRuns.includes('case "${PRODUCT}"'), false);
    for (const removed of [
      "package:rsgl:vsix",
      "verify:rsgl:vsix",
      "verify:build-budgets",
      "verify:vsix-budgets"
    ]) {
      assert.strictEqual(reusableRuns.includes(removed), false, removed);
    }
    assert.deepStrictEqual(getWorkflowTrigger(release.workflow, "push")?.tags, [
      "v*",
      "rsgl-cli-v*"
    ]);
    assert.deepStrictEqual(
      release.workflow.concurrency,
      {
        group: "release-${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}",
        "cancel-in-progress": false
      }
    );
  });

  it("keeps build credentials read-only and publishes only a verified immutable artifact", () => {
    const reusable = loadWorkflow("verify-release.yml");
    const release = loadWorkflow("release.yml");
    const contract = getWorkflowJob(release.workflow, "contract");
    const build = getWorkflowJob(release.workflow, "build");
    const marketplace = getWorkflowJob(release.workflow, "publish_marketplace");
    const cli = getWorkflowJob(release.workflow, "publish_cli");

    assert.deepStrictEqual(release.workflow.permissions, { contents: "read" });
    assert.deepStrictEqual(build.permissions, { contents: "read" });
    assert.strictEqual(
      getWorkflowStep(release.workflow, "contract", "Checkout release tag").with?.["persist-credentials"],
      false
    );
    assert.strictEqual(contract.outputs?.commit, "${{ steps.contract.outputs.commit }}");
    assertNoSecretReferences(contract, "contract job");
    assertNoSecretReferences(build, "build job");
    assertNoSecretReferences(reusable.workflow, "reusable verification workflow");

    const upload = getWorkflowStep(release.workflow, "build", "Upload immutable artifact");
    assert.strictEqual(actionName(upload), "actions/upload-artifact");
    assert.strictEqual(upload.with?.["if-no-files-found"], "error");
    assertRunIncludes(release.workflow, "build", "Generate SHA-256 digest", "SHA256SUMS");
    assertRunIncludes(
      release.workflow,
      "build",
      "Install pinned Marketplace publishing client",
      "npm ci --prefix tools/vsce-publisher --ignore-scripts"
    );
    assertRunIncludes(
      release.workflow,
      "build",
      "Smoke test pinned Marketplace publishing client",
      "node tools/vsce-publisher/node_modules/@vscode/vsce/vsce --version"
    );
    assertRunIncludes(release.workflow, "build", "Archive pinned Marketplace publishing client", "vsce-publisher.tgz");
    assert.strictEqual(build.outputs?.publisher_sha256, "${{ steps.publisher.outputs.sha256 }}");

    for (const [jobId, publish] of [[
      "publish_marketplace",
      marketplace
    ], [
      "publish_cli",
      cli
    ]] as const) {
      assert.strictEqual(publish.environment, "release");
      assert.strictEqual(permission(publish, "contents"), "write");
      const download = getWorkflowStep(release.workflow, jobId, "Download immutable artifact");
      assert.strictEqual(actionName(download), "actions/download-artifact");
      assert.strictEqual(download.with?.["artifact-ids"], "${{ needs.build.outputs.artifact_id }}");
      assert.strictEqual(hasStepEnv(publish, "EXPECTED_SHA256"), true, `${jobId} EXPECTED_SHA256`);
      assert.strictEqual(hasStepEnv(publish, "EXPECTED_COMMIT"), true, `${jobId} EXPECTED_COMMIT`);
      assert.strictEqual(hasStepEnv(publish, "GH_REPO", "${{ github.repository }}"), true, `${jobId} GH_REPO`);
      assert.strictEqual(
        (publish.steps ?? []).some(step => step.uses?.startsWith("actions/checkout@")),
        false,
        `${jobId} must not checkout or rebuild source`
      );
      const publishRun = jobRunText(publish);
      assert.strictEqual(publishRun.includes("npm ci"), false, jobId);
      assert.strictEqual(publishRun.includes("npm run package:"), false, jobId);
      assert.match(
        publishRun,
        /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/commits\/\$\{RELEASE_TAG\}"/,
        jobId
      );
    }

    assert.strictEqual(permission(marketplace, "id-token"), undefined);
    assert.strictEqual(hasStepEnv(marketplace, "EXPECTED_PUBLISHER_SHA256"), true);
    const marketplaceRun = jobRunText(marketplace);
    assert.match(marketplaceRun, /marketplace\.visualstudio\.com\/_apis\/public\/gallery\/publishers/);
    assert.match(marketplaceRun, /PUBLISHED_SHA256/);
    assert.match(marketplaceRun, /EXPECTED_SHA256/);
    assert.strictEqual(marketplaceRun.includes("npx --yes"), false);
    assert.strictEqual(marketplaceRun.includes("--skip-duplicate"), false);
    const publishMarketplace = getWorkflowStep(
      release.workflow,
      "publish_marketplace",
      "Publish to VS Code Marketplace"
    );
    assert.strictEqual(
      publishMarketplace.if,
      "steps.marketplace.outputs.already_published != 'true'"
    );
    assert.match(
      publishMarketplace.run ?? "",
      /node release\/vsce-publisher\/node_modules\/@vscode\/vsce\/vsce publish/
    );

    assert.strictEqual(permission(cli, "id-token"), "write");
    const cliPublishRun = stepRun(getWorkflowStep(release.workflow, "publish_cli", "Publish RSGL CLI to npm"));
    assert.match(
      cliPublishRun,
      /npm publish "\.\/release\/\$\{ASSET_NAME\}" --access public --provenance/
    );
    assert.match(cliPublishRun, /dist\.integrity/);
    assert.match(cliPublishRun, /LOCAL_INTEGRITY/);
    assert.match(cliPublishRun, /already published with the verified artifact; continuing/);
  });

  function describeTag(tag: string): Record<string, string> {
    const result = runTestProcessSync(
      process.execPath,
      [path.join(root, "scripts", "release-contract.mjs"), "describe", "--tag", tag],
      { cwd: root }
    );
    assertTestProcessStatus(result);
    return Object.fromEntries(result.stdout.trim().split(/\r?\n/).map(line => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  }

  function read(relativePath: string): string {
    return fs.readFileSync(path.join(root, relativePath), "utf8");
  }

  function loadWorkflow(fileName: string): LoadedWorkflow {
    const absoluteFileName = path.join(root, ".github", "workflows", fileName);
    return { fileName: absoluteFileName, workflow: loadGitHubWorkflow(absoluteFileName) };
  }
});

interface Manifest {
  name: string;
  version: string;
  publisher?: string;
  extensionPack?: string[];
  extensionDependencies?: string[];
  scripts?: Record<string, string>;
}

function readJson<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(fileName, "utf8")) as T;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSingleCommandStep(
  workflow: GitHubWorkflow,
  jobId: string,
  stepName: string,
  command: string
): void {
  const run = stepRun(getWorkflowStep(workflow, jobId, stepName));
  assert.ok(run.includes(command), `${stepName} must run ${command}; received: ${run}`);
  assert.strictEqual(
    run.includes("\n"),
    false,
    `${stepName} must keep one external command at its failure boundary; received: ${run}`
  );
}

function assertRunIncludes(
  workflow: GitHubWorkflow,
  jobId: string,
  stepName: string,
  expected: string
): void {
  const run = stepRun(getWorkflowStep(workflow, jobId, stepName));
  assert.ok(run.includes(expected), `${jobId}/${stepName} must include ${expected}; received: ${run}`);
}

function stepRun(step: WorkflowStep): string {
  if (typeof step.run !== "string") {
    assert.fail(`${step.name ?? "unnamed step"} must have a run command`);
  }
  return step.run;
}

function stepIndex(steps: readonly WorkflowStep[], stepName: string): number {
  const index = steps.findIndex(step => step.name === stepName);
  assert.notStrictEqual(index, -1, `Missing workflow step: ${stepName}`);
  return index;
}

function jobRunText(job: WorkflowJob): string {
  return (job.steps ?? []).flatMap(step => step.run ?? []).join("\n");
}

function hasStepEnv(job: WorkflowJob, key: string, expected?: unknown): boolean {
  return (job.steps ?? []).some(step => {
    if (!step.env || !Object.prototype.hasOwnProperty.call(step.env, key)) {
      return false;
    }
    return expected === undefined || step.env[key] === expected;
  });
}

function permission(job: WorkflowJob, name: string): string | undefined {
  return job.permissions && typeof job.permissions === "object"
    ? job.permissions[name]
    : undefined;
}

function actionName(step: WorkflowStep): string | undefined {
  return step.uses?.split("@", 1)[0];
}

function assertNoSecretReferences(value: unknown, label: string): void {
  const serialized = JSON.stringify(value);
  assert.strictEqual(serialized.includes("secrets."), false, `${label} must not reference release secrets`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}
