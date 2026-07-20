import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

describe("VSIX packaging output", () => {
  const repositoryRoot = process.cwd();
  let temporaryRoot: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-res-vsix-output-"));
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("creates a missing parent for a repository-relative --out path", () => {
    const args = prepareArguments(["--out", path.join("dist", "nested", "main.vsix")]);
    const expectedOutput = path.join(temporaryRoot, "dist", "nested", "main.vsix");

    assert.deepStrictEqual(args, ["--out", expectedOutput]);
    assert.ok(fs.statSync(path.dirname(expectedOutput)).isDirectory());
  });

  it("supports --out= and short -o forms without changing absolute outputs", () => {
    const absoluteOutput = path.join(temporaryRoot, "absolute", "combined.vsix");
    const equalsArgs = prepareArguments(["--out=artifacts/combined.vsix"]);
    const shortArgs = prepareArguments(["-o", absoluteOutput]);

    assert.deepStrictEqual(equalsArgs, [
      `--out=${path.join(temporaryRoot, "artifacts", "combined.vsix")}`
    ]);
    assert.deepStrictEqual(shortArgs, ["-o", absoluteOutput]);
    assert.ok(fs.statSync(path.join(temporaryRoot, "artifacts")).isDirectory());
    assert.ok(fs.statSync(path.dirname(absoluteOutput)).isDirectory());
  });

  function prepareArguments(args: string[]): string[] {
    const helperUrl = pathToFileURL(
      path.join(repositoryRoot, "scripts", "vsix-package-output.mjs")
    ).href;
    const program = [
      `import { prepareVsixPackageArguments } from ${JSON.stringify(helperUrl)};`,
      `const result = prepareVsixPackageArguments(${JSON.stringify(args)}, ${JSON.stringify(temporaryRoot)});`,
      "process.stdout.write(JSON.stringify(result));"
    ].join("\n");
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { cwd: repositoryRoot, encoding: "utf8" }
    );
    return JSON.parse(output) as string[];
  }
});
