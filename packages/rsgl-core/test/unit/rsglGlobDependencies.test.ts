import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  compileDependencyPatternStructurallyMatchesPath,
  compileDependencyStructuralWatchPatterns,
  compileRsglFile,
  type CompileDependency
} from "../../src/compiler";
import { searchRootForPattern } from "../../src/compiler/fileGlob";

describe("RSGL glob compile dependencies", () => {
  it("records the static pattern and every matched file from environment pre-evaluation", () => {
    const root = createTempDir();
    const sourceFile = path.join(root, "main.rsgl");
    const matchesDirectory = path.join(root, "matches");
    const firstMatch = path.join(matchesDirectory, "first.json");
    const secondMatch = path.join(matchesDirectory, "second.json");
    try {
      fs.mkdirSync(matchesDirectory, { recursive: true });
      fs.writeFileSync(firstMatch, "{}");
      fs.writeFileSync(secondMatch, "{}");
      fs.writeFileSync(sourceFile, [
        "let files = glob(\"./matches/*.json\")",
        "json \"assets/minecraft/glob-dependencies.json\" { files files }"
      ].join("\n"));

      const result = compileRsglFile(sourceFile);
      const globDependencies = result.dependencies.filter(dependency => dependency.reason === "glob");

      assert.deepStrictEqual(
        exactDependencyPaths(globDependencies).sort(),
        [path.resolve(firstMatch), path.resolve(secondMatch)].sort()
      );
      assert.deepStrictEqual(
        globDependencies
          .filter(dependency => dependency.globPattern)
          .map(dependency => ({ path: dependency.path, pattern: dependency.globPattern })),
        [{ path: path.resolve(matchesDirectory), pattern: "*.json" }]
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records an empty glob pattern so a future matching create can invalidate the compile", () => {
    const root = createTempDir();
    const sourceFile = path.join(root, "main.rsgl");
    const futureDirectory = path.join(root, "future", "nested");
    try {
      fs.writeFileSync(sourceFile, [
        "let files = glob(\"./future/nested/*.json\")",
        "json \"assets/minecraft/future-dependencies.json\" { files files }"
      ].join("\n"));

      const result = compileRsglFile(sourceFile);
      const pattern = result.dependencies.find(dependency => dependency.globPattern === "*.json");

      assert.ok(pattern);
      assert.strictEqual(pattern.path, path.resolve(futureDirectory));
      assert.deepStrictEqual(exactDependencyPaths(
        result.dependencies.filter(dependency => dependency.reason === "glob")
      ), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records pack metadata candidates consulted by pack-relative glob resolution", () => {
    const root = createTempDir();
    const packRoot = path.join(root, "pack");
    const sourceFile = path.join(packRoot, "rsgl", "main.rsgl");
    try {
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(sourceFile, [
        "let files = glob(\"assets/minecraft/textures/block/*.png\")",
        "json \"assets/minecraft/pack-glob-dependencies.json\" { files files }"
      ].join("\n"));

      const result = compileRsglFile(sourceFile);

      assert.ok(exactDependencyPaths(result.dependencies).includes(
        path.join(packRoot, "pack.mcmeta")
      ));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the filesystem root when the first path segment is a wildcard", () => {
    const filesystemRoot = path.parse(process.cwd()).root;

    assert.strictEqual(
      searchRootForPattern(path.join(filesystemRoot, "*.json")),
      path.normalize(filesystemRoot)
    );
  });

  it("starts absolute-pattern pack discovery at the static search root", () => {
    const root = createTempDir();
    const packRoot = path.join(root, "pack");
    const sourceFile = path.join(root, "source", "main.rsgl");
    const match = path.join(packRoot, "matched.json");
    try {
      fs.mkdirSync(packRoot, { recursive: true });
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      fs.writeFileSync(match, "{}");
      const absolutePattern = path.join(packRoot, "*.json");
      fs.writeFileSync(sourceFile, [
        `let files = glob(${JSON.stringify(absolutePattern)})`,
        "json \"assets/minecraft/absolute-glob.json\" { files files }"
      ].join("\n"));

      const result = compileRsglFile(sourceFile);

      assert.ok(exactDependencyPaths(result.dependencies).includes(
        path.join(packRoot, "pack.mcmeta")
      ));
      assert.ok(exactDependencyPaths(result.dependencies).includes(match));
      assert.ok(result.dependencies.some(dependency =>
        dependency.globPattern === "*.json" && dependency.path === path.resolve(packRoot)
      ));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives structural supersets for recursive wildcards in every segment position", () => {
    const basePath = path.resolve("virtual", "structural-globs");
    const patterns = (pattern: string): string[] =>
      compileDependencyStructuralWatchPatterns({ basePath, pattern })
        .map(selector => selector.pattern);

    assert.deepStrictEqual(patterns("*.json"), []);
    assert.deepStrictEqual(patterns("**"), ["**"]);
    assert.deepStrictEqual(patterns("**.json"), ["**"]);
    assert.deepStrictEqual(patterns("foo/**"), ["foo", "foo/**"]);
    assert.deepStrictEqual(patterns("foo/**bar"), ["foo", "foo/**"]);
    assert.strictEqual(
      compileDependencyPatternStructurallyMatchesPath(
        { basePath, pattern: "**.json" },
        path.join(basePath, "moved-directory")
      ),
      true
    );
    assert.strictEqual(
      compileDependencyPatternStructurallyMatchesPath(
        { basePath, pattern: "foo/**bar" },
        path.join(basePath, "foo", "deep-directory")
      ),
      true
    );
  });
});

function exactDependencyPaths(dependencies: readonly CompileDependency[]): string[] {
  return dependencies
    .filter(dependency => !dependency.globPattern)
    .map(dependency => path.resolve(dependency.path));
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rsgl-glob-dependencies-"));
}
