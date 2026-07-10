import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("independent extension package isolation", () => {
  it("keeps rsgl-core out of the main VSIX and limits intentional duplication to mc-assets", () => {
    const root = process.cwd();
    const mainIgnore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");
    const rsglTsconfig = JSON.parse(
      fs.readFileSync(path.join(root, "extensions", "vscode-rsgl", "tsconfig.json"), "utf8")
    ) as { include?: string[] };
    const testRoot = path.join(root, "src", "test") + path.sep;
    const mainSources = listTypeScriptFiles(path.join(root, "src"))
      .filter(fileName => !fileName.startsWith(testRoot))
      .map(fileName => fs.readFileSync(fileName, "utf8"))
      .join("\n");

    assert.match(mainIgnore, /^out\/packages\/\*\*$/m);
    assert.match(mainIgnore, /^!out\/packages\/mc-assets\/src\/\*\*\/\*\.js$/m);
    assert.strictEqual(mainIgnore.includes("!out/packages/rsgl-core"), false);
    assert.strictEqual(mainSources.includes("packages/rsgl-core"), false);
    assert.ok(rsglTsconfig.include?.includes("../../packages/mc-assets/src/**/*.ts"));
    assert.ok(rsglTsconfig.include?.includes("../../packages/rsgl-core/src/**/*.ts"));
  });
});

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fileName = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(fileName));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fileName);
    }
  }
  return files;
}
