import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CompiledModuleOptions {
  repositoryRoot?: string;
}

/**
 * Resolves a TypeScript source file to its test-build JavaScript output and
 * rejects missing or stale output before a child-process harness loads it.
 */
export function resolveFreshCompiledModule(
  sourceFile: string,
  options: CompiledModuleOptions = {}
): string {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const absoluteSource = path.resolve(repositoryRoot, sourceFile);
  const relativeSource = path.relative(repositoryRoot, absoluteSource);
  assert.ok(
    relativeSource.length > 0
      && !relativeSource.startsWith(`..${path.sep}`)
      && relativeSource !== ".."
      && !path.isAbsolute(relativeSource),
    `Compiled harness source must stay inside ${repositoryRoot}: ${sourceFile}`
  );
  assert.strictEqual(
    path.extname(relativeSource),
    ".ts",
    `Compiled harness source must be a .ts file: ${absoluteSource}`
  );
  assert.ok(
    fs.existsSync(absoluteSource),
    `Compiled harness source does not exist: ${absoluteSource}`
  );

  const compiledFile = path.join(
    repositoryRoot,
    "out",
    relativeSource.slice(0, -path.extname(relativeSource).length) + ".js"
  );
  assert.ok(
    fs.existsSync(compiledFile),
    `Compiled harness output does not exist: ${compiledFile}\nRun npm run build:test before executing compiled-output tests.`
  );

  const sourceModified = fs.statSync(absoluteSource).mtimeMs;
  const outputModified = fs.statSync(compiledFile).mtimeMs;
  assert.ok(
    outputModified >= sourceModified,
    [
      `Compiled harness output is stale: ${compiledFile}`,
      `source: ${absoluteSource} (${new Date(sourceModified).toISOString()})`,
      `output: ${compiledFile} (${new Date(outputModified).toISOString()})`,
      "Run npm run build:test before executing compiled-output tests."
    ].join("\n")
  );
  return compiledFile;
}
