import * as assert from "node:assert";
import * as path from "node:path";
import { isSamePath } from "../../src";

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
});
