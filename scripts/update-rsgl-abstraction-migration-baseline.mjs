#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const fixtureRoot = path.join(
  repositoryRoot,
  "packages",
  "rsgl-core",
  "test",
  "fixtures",
  "abstraction-migration"
);
const legacyRoot = path.join(fixtureRoot, "legacy");
const baselineFile = path.join(fixtureRoot, "legacy.snapshot.json");
const compilerFile = path.join(
  repositoryRoot,
  "out",
  "packages",
  "rsgl-core",
  "src",
  "compiler",
  "index.js"
);

requireFile(compilerFile, "Run `npm run compile` before refreshing the abstraction-migration baseline.");
requireFile(baselineFile, `Missing frozen baseline: ${baselineFile}`);

const compilerNamespace = await import(pathToFileURL(compilerFile).href);
const compiler = compilerNamespace.default ?? compilerNamespace;
const previous = JSON.parse(readFileSync(baselineFile, "utf8"));
const result = compiler.compileRsglDirectory(legacyRoot);
const actual = compiler.createRsglCompileSnapshot(result, { sourceRoot: legacyRoot });

if (actual.resources.length !== 12) {
  fail(`Legacy abstraction migration produced ${actual.resources.length} resources; expected 12.`);
}

const previousOutput = outputAndJsonProjection(previous);
const actualOutput = outputAndJsonProjection(actual);
if (JSON.stringify(actualOutput) !== JSON.stringify(previousOutput)) {
  fail("Refusing to refresh: legacy outputPath/JSON content changed.");
}

const rootMetadata = actual.resources.find(resource =>
  resource.outputPath.endsWith("root_merge_value_helper.json")
);
const expectedRootMetadata = {
  custom: {
    enabled: true,
    label: "value-helper",
    source: "template"
  },
  variants: {
    "": { model: "minecraft:block/stone" }
  }
};
if (JSON.stringify(rootMetadata?.content) !== JSON.stringify(expectedRootMetadata)) {
  fail("Refusing to refresh: the rootMetadata compatibility output changed.");
}

writeFileSync(baselineFile, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
console.log(`Updated abstraction-migration legacy baseline: ${baselineFile}`);
console.log(`${actual.resources.length} resources, ${actual.diagnostics.length} diagnostics`);

function outputAndJsonProjection(snapshot) {
  return snapshot.resources.map(resource => ({
    outputPath: resource.outputPath,
    content: resource.content
  }));
}

function requireFile(fileName, message) {
  if (!existsSync(fileName)) {
    fail(message);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
