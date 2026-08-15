import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePathKey, uniqueValues } from "../../src";

describe("shared collection helpers", () => {
  it("deduplicates iterables while preserving first-seen order", () => {
    assert.deepStrictEqual(uniqueValues(["b", "a", "b", "c", "a"]), ["b", "a", "c"]);
    assert.deepStrictEqual(uniqueValues(new Set([3, 1, 2])), [3, 1, 2]);
  });

  it("keeps one array-deduplication implementation across source packages", () => {
    const sourceFiles = ["src", "packages", "extensions"]
      .flatMap(root => collectTypeScriptFiles(path.join(process.cwd(), root)))
      .filter(fileName => !fileName.endsWith("collections.test.ts"));
    const offenders = sourceFiles
      .filter(fileName => {
        const source = fs.readFileSync(fileName, "utf8");
        return source.includes("[...new Set(")
          || source.includes("Array.from(new Set(")
          || /function\s+unique\s*\(/.test(source);
      })
      .map(fileName => normalizePathKey(path.relative(process.cwd(), fileName)));

    assert.deepStrictEqual(offenders, [normalizePathKey(path.join("packages", "mc-assets", "src", "collections.ts"))]);
  });
});

function collectTypeScriptFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "out" && entry.name !== "node_modules") {
        files.push(...collectTypeScriptFiles(path.join(directory, entry.name)));
      }
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}
