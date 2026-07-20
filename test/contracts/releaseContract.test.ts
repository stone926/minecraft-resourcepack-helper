import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

describe("single-extension release contracts", () => {
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
        "verify:rsgl-cli"
      ]
    );
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
    const ci = read(".github/workflows/ci.yml");
    const reusable = read(".github/workflows/verify-release.yml");
    const release = read(".github/workflows/release.yml");

    assert.match(ci, /uses: \.\/\.github\/workflows\/verify-release\.yml/);
    assert.match(release, /uses: \.\/\.github\/workflows\/verify-release\.yml/);
    assert.match(release, /source_ref: \$\{\{ needs\.contract\.outputs\.commit \}\}/);
    assert.match(reusable, /ubuntu-latest/);
    assert.match(reusable, /windows-latest/);
    assert.match(reusable, /package:main:vsix/);
    assert.match(reusable, /package:rsgl-cli/);
    assert.match(reusable, /verify:main:vsix/);
    assert.match(reusable, /verify:rsgl-cli/);
    assert.strictEqual(reusable.includes("package:rsgl:vsix"), false);
    assert.strictEqual(reusable.includes("verify:rsgl:vsix"), false);
    assert.strictEqual(reusable.includes("verify:build-budgets"), false);
    assert.strictEqual(reusable.includes("verify:vsix-budgets"), false);
    assertSingleCommandStep(
      reusable,
      "Package main extension",
      "npm run package:main:vsix -- --out"
    );
    assertSingleCommandStep(
      reusable,
      "Verify main extension package",
      "npm run verify:main:vsix --"
    );
    assertSingleCommandStep(
      reusable,
      "Package RSGL CLI",
      "npm run package:rsgl-cli -- --out"
    );
    assertSingleCommandStep(
      reusable,
      "Verify RSGL CLI package",
      "npm run verify:rsgl-cli --"
    );
    assertSingleCommandStep(
      release,
      "Package selected product",
      "node scripts/artifact.mjs package"
    );
    assertSingleCommandStep(
      release,
      "Verify selected product",
      "node scripts/artifact.mjs verify"
    );
    assert.ok(
      release.indexOf("artifact.mjs package") < release.indexOf("artifact.mjs verify"),
      "immutable artifact verification must follow packaging"
    );
    assert.strictEqual(release.includes('case "${PRODUCT}"'), false);
    assert.match(release, /- "v\*"/);
    assert.strictEqual(release.includes('- "rsgl-v*"'), false);
    assert.match(release, /- "rsgl-cli-v\*"/);
    assert.match(
      release,
      /group: release-\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref_name \}\}/
    );
    assert.strictEqual(
      /^\s*group: release-.*\|\| github\.ref \}\}$/m.test(release),
      false
    );

  });

  it("keeps build credentials read-only and publishes only a verified immutable artifact", () => {
    const reusable = read(".github/workflows/verify-release.yml");
    const release = read(".github/workflows/release.yml");
    const contract = jobSection(release, "contract");
    const build = jobSection(release, "build");
    const marketplace = jobSection(release, "publish_marketplace");
    const cli = jobSection(release, "publish_cli");

    assert.match(contract, /persist-credentials: false/);
    assert.match(contract, /commit: \$\{\{ steps\.contract\.outputs\.commit \}\}/);
    assert.match(build, /permissions:\s*\n\s+contents: read/);
    assert.strictEqual(contract.includes("secrets."), false);
    assert.strictEqual(build.includes("secrets."), false);
    assert.strictEqual(reusable.includes("secrets."), false);
    assert.match(build, /actions\/upload-artifact@[0-9a-f]{40}/);
    assert.match(build, /SHA256SUMS/);
    assert.match(build, /npm ci --prefix tools\/vsce-publisher --ignore-scripts/);
    assert.match(build, /node tools\/vsce-publisher\/node_modules\/@vscode\/vsce\/vsce --version/);
    assert.match(build, /vsce-publisher\.tgz/);
    assert.match(build, /publisher_sha256/);
    for (const publish of [marketplace, cli]) {
      assert.match(publish, /environment: release/);
      assert.match(publish, /contents: write/);
      assert.match(publish, /artifact-ids:/);
      assert.match(publish, /EXPECTED_SHA256/);
      assert.strictEqual(publish.includes("actions/checkout"), false);
      assert.strictEqual(publish.includes("npm ci"), false);
      assert.strictEqual(publish.includes("npm run package:"), false);
      assert.match(publish, /EXPECTED_COMMIT/);
      assert.match(publish, /GH_REPO: \$\{\{ github\.repository \}\}/);
      assert.match(publish, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/commits\/\$\{RELEASE_TAG\}"/);
    }
    assert.strictEqual(marketplace.includes("id-token: write"), false);
    assert.match(marketplace, /EXPECTED_PUBLISHER_SHA256/);
    assert.match(marketplace, /node release\/vsce-publisher\/node_modules\/@vscode\/vsce\/vsce publish/);
    assert.strictEqual(marketplace.includes("npx --yes"), false);
    assert.match(marketplace, /marketplace\.visualstudio\.com\/_apis\/public\/gallery\/publishers/);
    assert.match(marketplace, /PUBLISHED_SHA256/);
    assert.match(marketplace, /EXPECTED_SHA256/);
    assert.match(marketplace, /steps\.marketplace\.outputs\.already_published != 'true'/);
    assert.strictEqual(marketplace.includes("--skip-duplicate"), false);
    assert.match(cli, /id-token: write/);
    assert.match(cli, /npm publish .*--provenance/);
    assert.match(cli, /dist\.integrity/);
    assert.match(cli, /LOCAL_INTEGRITY/);
    assert.match(cli, /already published with the verified artifact; continuing/);

    for (const source of [read(".github/workflows/ci.yml"), reusable, release]) {
      for (const match of source.matchAll(/^\s*uses:\s+([^\s#]+)(?:\s+#.*)?$/gm)) {
        const reference = match[1];
        if (!reference.startsWith("./")) {
          assert.match(reference, /^[^@]+@[0-9a-f]{40}$/, reference);
        }
      }
    }
  });

  function describeTag(tag: string): Record<string, string> {
    const output = execFileSync(
      process.execPath,
      [path.join(root, "scripts", "release-contract.mjs"), "describe", "--tag", tag],
      { cwd: root, encoding: "utf8" }
    );
    return Object.fromEntries(output.trim().split(/\r?\n/).map(line => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  }

  function read(relativePath: string): string {
    return fs.readFileSync(path.join(root, relativePath), "utf8");
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

function jobSection(workflow: string, jobName: string): string {
  const normalized = workflow.replace(/\r\n/g, "\n");
  const marker = `  ${jobName}:\n`;
  const start = normalized.indexOf(marker);
  assert.notStrictEqual(start, -1, `Missing workflow job: ${jobName}`);
  const nextJob = /^ {2}[a-zA-Z0-9_-]+:\n/gm;
  nextJob.lastIndex = start + marker.length;
  const next = nextJob.exec(normalized);
  return normalized.slice(start, next?.index ?? normalized.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSingleCommandStep(workflow: string, stepName: string, command: string): void {
  const normalized = workflow.replace(/\r\n/g, "\n");
  const marker = `      - name: ${stepName}\n`;
  const start = normalized.indexOf(marker);
  assert.notStrictEqual(start, -1, `Missing workflow step: ${stepName}`);
  const nextStep = /^ {6}- name: /gm;
  nextStep.lastIndex = start + marker.length;
  const next = nextStep.exec(normalized);
  const step = normalized.slice(start, next?.index ?? normalized.length);
  const runLines = step.match(/^\s*run:\s*(.+)$/gm) ?? [];
  assert.strictEqual(runLines.length, 1, `${stepName} must contain one run command`);
  assert.ok(runLines[0].includes(command), `${stepName} must run ${command}`);
  assert.strictEqual(step.includes("run: |"), false, `${stepName} must fail at its command boundary`);
}
