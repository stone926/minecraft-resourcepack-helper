import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("filesystem path identity contract", () => {
  const root = process.cwd();
  const productionRoots = [
    "src",
    "packages/rsgl-cli/src",
    "packages/rsgl-core/src",
    "packages/rsgl-lsp/src",
    "packages/rsgl-shared/src"
  ];

  it("uses the shared mc-assets path-key policy instead of local case folding", () => {
    for (const relativeRoot of productionRoots) {
      const sourceRoot = path.join(root, relativeRoot);
      for (const fileName of listTypeScriptFiles(sourceRoot)) {
        const source = fs.readFileSync(fileName, "utf8");
        assert.doesNotMatch(
          source,
          /process\.platform\s*===\s*["']win32["'][^\n]*toLowerCase\(\)/,
          `${portableRelativePath(root, fileName)} defines an ad-hoc case-folded path key`
        );
      }
    }
  });

  it("does not use a dot-dot string prefix as a path-containment check", () => {
    for (const relativeRoot of productionRoots) {
      for (const fileName of listTypeScriptFiles(path.join(root, relativeRoot))) {
        const source = fs.readFileSync(fileName, "utf8");
        assert.doesNotMatch(
          source,
          /\.startsWith\(["']\.\.["']\)/,
          `${portableRelativePath(root, fileName)} rejects legal dot-dot-prefixed names`
        );
      }
    }
  });
});

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fileName = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(fileName));
    } else if (entry.isFile() && fileName.endsWith(".ts")) {
      files.push(fileName);
    }
  }
  return files;
}

function portableRelativePath(root: string, fileName: string): string {
  return path.relative(root, fileName).replaceAll(path.sep, "/");
}
