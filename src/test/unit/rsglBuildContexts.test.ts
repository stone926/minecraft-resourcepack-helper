import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

describe("RSGL build contexts", () => {
  it("resolves the current-file command as an authoritative source-directory build", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsgl-build-context-"));
    try {
      const sourceRoot = path.join(projectRoot, "rsgl");
      const mainSource = path.join(sourceRoot, "main.rsgl");
      const siblingSource = path.join(sourceRoot, "sibling.rsgl");
      const outsideSource = path.join(projectRoot, "outside.rsgl");
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "rsgl.config.json"), JSON.stringify({
        root: "rsgl",
        outDir: "."
      }));
      for (const fileName of [mainSource, siblingSource, outsideSource]) {
        fs.writeFileSync(fileName, "");
      }

      const script = [
        "const assert = require('node:assert');",
        "const Module = require('node:module'); const originalLoad = Module._load;",
        "const [modulePath, projectRoot, sourceRoot, mainSource, siblingSource, outsideSource] = process.argv.slice(1);",
        "const saved = []; const messages = [];",
        "const uri = fileName => ({ scheme: 'file', fsPath: fileName, toString: () => `file:///${fileName}` });",
        "const document = fileName => ({",
        "  fileName, languageId: 'rsgl', uri: uri(fileName), isDirty: true,",
        "  save: async () => { saved.push(fileName); return true; }",
        "});",
        "const main = document(mainSource); const sibling = document(siblingSource); const outside = document(outsideSource);",
        "const vscode = {",
        "  l10n: { t: (value, ...args) => args.reduce((text, arg, index) => text.replace(`{${index}}`, String(arg)), value) },",
        "  workspace: { textDocuments: [main, sibling, outside], openTextDocument: async () => { throw new Error('unexpected open'); } },",
        "  window: {",
        "    activeTextEditor: { document: main },",
        "    showErrorMessage: async message => { messages.push(message); },",
        "    showOpenDialog: async () => { throw new Error('unexpected output-folder prompt'); }",
        "  }",
        "};",
        "Module._load = function(request, ...args) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args); };",
        "const { isDirectoryBuildContext, resolveFileBuildContext } = require(modulePath);",
        "(async () => {",
        "  const context = await resolveFileBuildContext(undefined);",
        "  assert.ok(context);",
        "  assert.strictEqual(isDirectoryBuildContext(context), true);",
        "  assert.deepStrictEqual(context, { sourceFileName: mainSource, outputRoot: projectRoot, sourceRoot });",
        "  assert.deepStrictEqual(saved.sort(), [mainSource, siblingSource].sort());",
        "  assert.deepStrictEqual(messages, []);",
        "  saved.length = 0; messages.length = 0; vscode.window.activeTextEditor = { document: outside };",
        "  const rejected = await resolveFileBuildContext(undefined);",
        "  assert.strictEqual(rejected, null);",
        "  assert.deepStrictEqual(saved, [], 'a source outside the configured root must be rejected before saving');",
        "  assert.deepStrictEqual(messages, [`The current RSGL file is outside the configured source directory: ${sourceRoot}`]);",
        "})().catch(error => { console.error(error); process.exitCode = 1; });"
      ].join("\n");
      const modulePath = path.join(
        process.cwd(),
        "out",
        "src",
        "rsgl",
        "host",
        "commands",
        "buildContexts.js"
      );
      const result = spawnSync(process.execPath, [
        "-e",
        script,
        modulePath,
        projectRoot,
        sourceRoot,
        mainSource,
        siblingSource,
        outsideSource
      ], { encoding: "utf8" });

      assert.strictEqual(result.status, 0, result.stderr);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
