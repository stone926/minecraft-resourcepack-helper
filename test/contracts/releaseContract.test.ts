import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

describe("independent release contracts", () => {
  const root = process.cwd();

  it("maps each tag namespace to exactly one independently versioned product", () => {
    const main = readJson<Manifest>(path.join(root, "package.json"));
    const rsgl = readJson<Manifest>(path.join(root, "extensions", "vscode-rsgl", "package.json"));
    const cli = readJson<Manifest>(path.join(root, "packages", "rsgl-cli", "package.json"));

    assert.match(rsgl.version, /^\d+\.\d+\.\d+$/);
    assert.match(cli.version, /^\d+\.\d+\.\d+$/);
    assert.deepStrictEqual(main.extensionPack, ["stone926.rsgl"]);
    assert.strictEqual(main.extensionDependencies, undefined);

    const mainRelease = describeTag(`v${main.version}`);
    const rsglRelease = describeTag(`rsgl-v${rsgl.version}`);
    const cliRelease = describeTag(`rsgl-cli-v${cli.version}`);

    assert.deepStrictEqual(
      [mainRelease.product, rsglRelease.product, cliRelease.product],
      ["main", "rsgl", "rsgl-cli"]
    );
    assert.strictEqual(mainRelease.asset_name, `${main.name}-${main.version}.vsix`);
    assert.strictEqual(rsglRelease.asset_name, `${rsgl.name}-${rsgl.version}.vsix`);
    assert.strictEqual(mainRelease.marketplace_publisher, main.publisher);
    assert.strictEqual(mainRelease.marketplace_extension, main.name);
    assert.strictEqual(rsglRelease.marketplace_publisher, rsgl.publisher);
    assert.strictEqual(rsglRelease.marketplace_extension, rsgl.name);
    assert.strictEqual(cliRelease.marketplace_publisher, undefined);
    assert.strictEqual(
      cliRelease.asset_name,
      `minecraft-resourcepack-helper-rsgl-cli-${cli.version}.tgz`
    );
    assert.strictEqual(cliRelease.publish_kind, "npm");
    for (const [changelogPath, currentVersion] of [
      ["extensions/vscode-rsgl/CHANGELOG.md", rsgl.version],
      ["packages/rsgl-cli/CHANGELOG.md", cli.version]
    ] as const) {
      const changelog = read(changelogPath);
      assert.match(changelog, /^## \[1\.0\.0\]/m, `${changelogPath} must retain its first release`);
      assert.match(
        changelog,
        new RegExp(`^## \\[${escapeRegExp(currentVersion)}\\]`, "m"),
        `${changelogPath} must describe its current manifest version`
      );
    }
  });

  it("keeps target-specific release and packaging entry points stable", () => {
    const manifest = readJson<Manifest>(path.join(root, "package.json"));
    const scripts = manifest.scripts ?? {};

    assert.strictEqual(scripts["build:rsgl-cli"], "npm run typecheck:rsgl-cli && npm run bundle:rsgl-cli");
    assert.strictEqual(scripts["package:rsgl-cli"], "node scripts/package-rsgl-cli.mjs");
    assert.strictEqual(scripts["verify:rsgl-cli"], "node scripts/verify-rsgl-cli-package.mjs");
    assert.strictEqual(scripts["release:main"], "node scripts/release.mjs main");
    assert.strictEqual(scripts["release:rsgl"], "node scripts/release.mjs rsgl");
    assert.strictEqual(scripts["release:rsgl:current"], "node scripts/release.mjs rsgl current");
    assert.strictEqual(scripts["release:rsgl-cli"], "node scripts/release.mjs rsgl-cli");
    assert.strictEqual(scripts["release:rsgl-cli:current"], "node scripts/release.mjs rsgl-cli current");

    const releaseSource = read("scripts/release.mjs");
    assert.match(releaseSource, /releaseTarget\(positional\[0\] \?\? "main"\)/);
    assert.match(releaseSource, /target\.manifestPath/);
    assert.match(releaseSource, /target\.changelogPath/);
    assert.strictEqual(releaseSource.includes("RSGL_VERSION"), false);

    const cliVerifier = read("scripts/verify-rsgl-cli-package.mjs");
    assert.match(cliVerifier, /"node_modules",\s*"\.bin"/);
    assert.match(cliVerifier, /process\.platform === "win32" \? "rsgl\.cmd" : "rsgl"/);
    assert.match(cliVerifier, /runInstalledCli\(entry, shim, \["--help"\]/);
    assert.match(cliVerifier, /resolveInstalledCliInvocation\(entry, shim, args\)/);
    assert.strictEqual(cliVerifier.includes('file: "cmd.exe"'), false);

    const cliInvocation = read("scripts/installed-cli-invocation.mjs");
    assert.match(cliInvocation, /platform === "win32"/);
    assert.match(cliInvocation, /file: options\.nodeExecutable \?\? process\.execPath/);
    assert.match(cliInvocation, /return \{ file: shim, args \}/);
  });

  it("uses official npm registry URLs in committed lockfiles", () => {
    for (const lockfile of [
      "package-lock.json",
      "extensions/vscode-rsgl/package-lock.json",
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
    assert.match(reusable, /package:rsgl:vsix/);
    assert.match(reusable, /package:rsgl-cli/);
    assert.match(reusable, /verify:build-budgets/);
    assert.match(reusable, /verify:vsix-budgets -- --main-vsix/);
    assert.match(reusable, /verify:vsix-budgets -- --rsgl-vsix/);
    assertSingleCommandStep(
      reusable,
      "Package main extension",
      "npm run package:main:vsix"
    );
    assertSingleCommandStep(
      reusable,
      "Verify main extension package",
      "npm run verify:vsix-budgets -- --main-vsix"
    );
    assertSingleCommandStep(
      reusable,
      "Package RSGL extension",
      "npm run package:rsgl:vsix"
    );
    assertSingleCommandStep(
      reusable,
      "Verify RSGL extension package",
      "npm run verify:rsgl:vsix"
    );
    assertSingleCommandStep(
      reusable,
      "Verify RSGL extension package budget",
      "npm run verify:vsix-budgets -- --rsgl-vsix"
    );
    assertSingleCommandStep(
      reusable,
      "Package RSGL CLI",
      "npm run package:rsgl-cli"
    );
    assertSingleCommandStep(
      reusable,
      "Verify RSGL CLI package",
      "npm run verify:rsgl-cli"
    );
    assert.match(release, /- "v\*"/);
    assert.match(release, /- "rsgl-v\*"/);
    assert.match(release, /- "rsgl-cli-v\*"/);
    assert.match(
      release,
      /group: release-\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref_name \}\}/
    );
    assert.strictEqual(
      /^\s*group: release-.*\|\| github\.ref \}\}$/m.test(release),
      false
    );

    const budgets = read("scripts/verify-build-budgets.mjs");
    assert.match(budgets, /const verifyAll = !argumentsByName\.mainVsix && !argumentsByName\.rsglVsix/);
    assert.match(budgets, /if \(verifyAll \|\| argumentsByName\.mainVsix\)/);
    assert.match(budgets, /if \(verifyAll \|\| argumentsByName\.rsglVsix\)/);
    assert.match(budgets, /if \(verifyAll\) \{\s*verifyBundle\("rsglCli"/);
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
