#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const defaultFixtureRoot = path.join(repositoryRoot, "docs", "better_textures_rsgl");
const expectedResourceCount = 1188;
const expectedSourceFileCount = 33;
const allowedErrorCodes = new Set(["rsgl.undeclaredExternalResource"]);
const allowedWarningCodes = new Set(["rsgl.unresolvedTextureVariable"]);

const options = parseArguments(process.argv.slice(2));
const fixtureRoot = path.resolve(options.fixtureRoot ?? defaultFixtureRoot);
const configFile = path.join(fixtureRoot, "rsgl.config.json");
const baselineFile = path.resolve(
  options.baselineFile ?? path.join(fixtureRoot, ".rsgl-abstraction-baseline.json")
);

requireFile(configFile, [
  `Better Textures fixture is required at ${fixtureRoot}.`,
  "The fixture lives under ignored docs/ and is intentionally not part of a clean checkout.",
  "Pass --fixture <directory> to use an externally mounted copy."
].join("\n"));

const core = await loadCommonJsModule(
  path.join(repositoryRoot, "out", "packages", "rsgl-core", "src", "index.js"),
  "Run `npm run build -- --typecheck-only` before invoking this script directly."
);

const config = core.readRsglProjectConfig(configFile);
const sourceRoot = config.root ?? path.join(fixtureRoot, "src");
if (!existsSync(sourceRoot)) {
  fail(`Configured Better Textures source root does not exist: ${sourceRoot}`);
}

const sourceFiles = core.loadRsglSourceFilesFromDirectory(sourceRoot);
const projectSourceFiles = sourceFiles.filter(sourceFile => isFileWithinRoot(fixtureRoot, sourceFile.fileName));
const result = core.compileRsglDirectory(sourceRoot, {
  ...core.projectCompileOptionsFromRsglConfig(config),
  globalExterns: config.extern,
  checkExternExistence: config.checkExternExistence,
  ...core.createRsglWorkspaceValidationOptions({
    sourceFileName: sourceRoot,
    defaultAssetsPath: config.defaultAssetsPath,
    resourcePackRoots: config.resourcePackRoots
  })
});
const snapshot = core.createRsglCompileSnapshot(result, { sourceRoot: fixtureRoot });
const actual = {
  version: 2,
  fixture: "better_textures_rsgl",
  sourceFileCount: projectSourceFiles.length,
  resourceCount: snapshot.resources.length,
  resourceBodyConsumers: core.rsglResourceKindDescriptors.map(descriptor => ({
    resourceKind: descriptor.keyword,
    astShape: descriptor.ast.shape,
    bodyDialect: descriptor.ast.bodyDialect,
    compileHandler: descriptor.compile.handler
  })),
  snapshot
};

if (actual.sourceFileCount !== expectedSourceFileCount) {
  fail(
    `Better Textures contains ${actual.sourceFileCount} project source files; expected ${expectedSourceFileCount}. `
    + "Refusing to update or accept the integration baseline."
  );
}
if (actual.resourceCount !== expectedResourceCount) {
  fail(
    `Better Textures generated ${actual.resourceCount} internal resources; expected ${expectedResourceCount}. `
    + "Refusing to update or accept the integration baseline."
  );
}
validateIntegrationDiagnostics(snapshot.diagnostics);

if (options.update) {
  mkdirSync(path.dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
  console.log(`Updated Better Textures RSGL baseline: ${baselineFile}`);
  printSummary(actual);
  process.exit(0);
}

requireFile(baselineFile, [
  `Better Textures baseline is required at ${baselineFile}.`,
  "Create the local ignored baseline with `npm run test:rsgl:better-textures -- --update`,",
  "or pass --baseline <file> for an externally mounted baseline."
].join("\n"));

const expected = parseJsonFile(baselineFile);
const expectedText = `${JSON.stringify(expected, null, 2)}\n`;
const actualText = `${JSON.stringify(actual, null, 2)}\n`;
if (actualText !== expectedText) {
  const difference = firstDifference(expectedText, actualText);
  fail([
    `Better Textures RSGL baseline mismatch at ${baselineFile}.`,
    difference,
    "Refresh with --update only after reviewing an intentional compiler or output change."
  ].join("\n"));
}

console.log(`Better Textures RSGL baseline verified: ${baselineFile}`);
printSummary(actual);

function validateIntegrationDiagnostics(diagnostics) {
  const unexpected = diagnostics.filter(diagnostic =>
    (diagnostic.severity === "error" && !allowedErrorCodes.has(diagnostic.code))
    || (diagnostic.severity === "warning" && !allowedWarningCodes.has(diagnostic.code))
  );
  if (unexpected.length === 0) {
    return;
  }

  const summary = unexpected.slice(0, 10).map(diagnostic =>
    `${diagnostic.severity} ${diagnostic.code}${diagnostic.fileName ? ` (${diagnostic.fileName})` : ""}`
  );
  fail([
    "Better Textures produced diagnostics outside the frozen reference-validation allowlist:",
    ...summary,
    ...(unexpected.length > summary.length ? [`... ${unexpected.length - summary.length} more`] : [])
  ].join("\n"));
}

function parseArguments(args) {
  const parsed = { update: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--update") {
      parsed.update = true;
    } else if (argument === "--fixture" || argument === "--baseline") {
      const value = args[++index];
      if (!value) {
        fail(`Missing value after ${argument}.`);
      }
      if (argument === "--fixture") {
        parsed.fixtureRoot = value;
      } else {
        parsed.baselineFile = value;
      }
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return parsed;
}

async function loadCommonJsModule(fileName, missingHint) {
  requireFile(fileName, missingHint);
  const namespace = await import(pathToFileURL(fileName).href);
  return namespace.default ?? namespace;
}

function requireFile(fileName, message) {
  if (!existsSync(fileName)) {
    fail(message);
  }
}

function parseJsonFile(fileName) {
  try {
    return JSON.parse(readFileSync(fileName, "utf8"));
  } catch (error) {
    fail(`Failed to parse ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isFileWithinRoot(root, fileName) {
  if (fileName.startsWith("<")) {
    return false;
  }
  const relative = path.relative(root, fileName);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const count = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < count; index++) {
    if (expectedLines[index] !== actualLines[index]) {
      return [
        `First difference at baseline line ${index + 1}:`,
        `expected: ${expectedLines[index] ?? "<end of file>"}`,
        `actual:   ${actualLines[index] ?? "<end of file>"}`
      ].join("\n");
    }
  }
  return "Baseline content differs.";
}

function printSummary(baseline) {
  const diagnostics = baseline.snapshot.diagnostics.reduce((counts, diagnostic) => {
    counts[diagnostic.severity] = (counts[diagnostic.severity] ?? 0) + 1;
    return counts;
  }, {});
  console.log([
    `${baseline.sourceFileCount} source files`,
    `${baseline.resourceCount} internal resources`,
    `${diagnostics.error ?? 0} errors`,
    `${diagnostics.warning ?? 0} warnings`
  ].join(", "));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
