import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { findByNormalizedPath, isSamePath } from "../../src";

describe("path keys", () => {
  it("compares paths after normalization", () => {
    const directory = path.join(path.parse(process.cwd()).root, "pack", "assets", "minecraft", "models", "block");
    const normalized = path.join(directory, "cube.json");
    const redundant = `${directory}${path.sep}.${path.sep}cube.json`;

    assert.strictEqual(isSamePath(normalized, redundant), true);
  });

  it("matches platform path case semantics", () => {
    const upperCase = path.join(path.parse(process.cwd()).root, "Pack", "Assets", "Minecraft");
    const lowerCase = path.join(path.parse(process.cwd()).root, "pack", "assets", "minecraft");

    assert.strictEqual(isSamePath(upperCase, lowerCase), process.platform === "win32");
  });

  it("finds values through one normalized-path lookup", () => {
    const directory = path.join(path.parse(process.cwd()).root, "pack", "models");
    const values = [
      { uri: "untitled:buffer", fileName: null },
      { uri: "file:model", fileName: path.join(directory, ".", "cube.json") }
    ];

    assert.strictEqual(
      findByNormalizedPath(
        values,
        path.join(directory, "cube.json"),
        value => value.fileName
      ),
      values[1]
    );
    assert.strictEqual(
      findByNormalizedPath(values, path.join(directory, "missing.json"), value => value.fileName),
      undefined
    );
  });

  it("keeps resource completion on the shared path comparison", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "services", "resourceCompletionService.ts"),
      "utf8"
    );

    assert.strictEqual(source.includes("function isSamePath"), false);
    assert.match(source, /isSamePath,/);
  });
});
