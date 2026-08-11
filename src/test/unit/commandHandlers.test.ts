import { resolveFreshCompiledModule } from "../../../test/helpers/compiledHarness";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../../../test/helpers/testProcess";

describe("contributed command handlers", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("opens the configured vanilla assets folder and treats a missing setting as cancellation", () => {
    const commandPath = resolveFreshCompiledModule("src/commands/openDefaultMcAssetsPath.ts");
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const configured = new Map(); const explicit = new Set(); const reads = []; const executions = [];",
      "const vscode = {",
      "  Uri: { file: fsPath => ({ scheme: 'file', fsPath, toString: () => `file:///${fsPath}` }) },",
      "  workspace: { getConfiguration: () => ({",
      "    get: key => { reads.push(key); return configured.get(key); },",
      "    inspect: key => explicit.has(key) ? { workspaceValue: configured.get(key) } : { defaultValue: '' }",
      "  }) },",
      "  commands: { executeCommand: (...args) => { executions.push(args); return Promise.resolve(); } }",
      "};",
      "Module._load = function(request, ...args) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args); };",
      "const command = require(process.argv[1]).default;",
      "assert.strictEqual(command(), undefined);",
      "assert.deepStrictEqual(executions, []);",
      "configured.set('McResHelper.defaultMcAssetsPath', 'C:/Minecraft 资源/legacy');",
      "assert.strictEqual(command(), undefined);",
      "configured.set('McResHelper.vanillaResourcePackPath', 'C:/Minecraft 资源/canonical');",
      "explicit.add('McResHelper.vanillaResourcePackPath');",
      "assert.strictEqual(command(), undefined);",
      "configured.set('McResHelper.vanillaResourcePackPath', '');",
      "assert.strictEqual(command(), undefined);",
      "assert.ok(reads.includes('McResHelper.defaultMcAssetsPath'));",
      "assert.ok(reads.includes('McResHelper.vanillaResourcePackPath'));",
      "assert.strictEqual(executions.length, 2);",
      "assert.strictEqual(executions[0][0], 'vscode.openFolder');",
      "assert.strictEqual(executions[0][1].fsPath, 'C:/Minecraft 资源/legacy');",
      "assert.deepStrictEqual(executions[0][2], { forceNewWindow: true });",
      "assert.strictEqual(executions[1][1].fsPath, 'C:/Minecraft 资源/canonical');"
    ].join("\n");

    const result = runTestProcessSync(process.execPath, ["-e", script, commandPath]);
    assertTestProcessStatus(result);
  });

  it("reports invalid CIT sources, honors save cancellation, and writes a successful conversion", () => {
    const commandPath = resolveFreshCompiledModule("src/cit/commands/generateCitForCurrentItem.ts");
    const script = [
      "const assert = require('node:assert/strict');",
      "const path = require('node:path');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const uri = fsPath => ({ scheme: 'file', fsPath, toString: () => `file:///${fsPath}` });",
      "const errors = []; const saveOptions = []; const directories = []; const writes = []; const opened = []; const shown = [];",
      "let saveTarget;",
      "const vscode = {",
      "  Uri: { file: uri },",
      "  l10n: { t: value => value },",
      "  window: {",
      "    activeTextEditor: undefined,",
      "    showErrorMessage: async message => { errors.push(message); },",
      "    showSaveDialog: async options => { saveOptions.push(options); return saveTarget; },",
      "    showTextDocument: async document => { shown.push(document); }",
      "  },",
      "  workspace: {",
      "    fs: {",
      "      createDirectory: async target => { directories.push(target); },",
      "      writeFile: async (target, bytes) => { writes.push([target, Buffer.from(bytes)]); }",
      "    },",
      "    openTextDocument: async target => { const document = { uri: target }; opened.push(document); return document; }",
      "  }",
      "};",
      "Module._load = function(request, ...args) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args); };",
      "const command = require(process.argv[1]).default;",
      "const root = path.join(process.cwd(), 'temporary command pack');",
      "(async () => {",
      "  assert.strictEqual(await command(), null);",
      "  vscode.window.activeTextEditor = { document: { uri: uri(path.join(root, 'README.txt')), fileName: path.join(root, 'README.txt') } };",
      "  assert.strictEqual(await command(), null);",
      "  assert.deepStrictEqual(errors, ['No item resource editor is active', 'Current resource cannot be converted to a CIT']);",
      "  const source = path.join(root, 'assets', 'demo', 'models', 'item', 'hammer.json');",
      "  vscode.window.activeTextEditor = { document: { uri: uri(source), fileName: source } };",
      "  saveTarget = undefined;",
      "  assert.strictEqual(await command(), null);",
      "  assert.strictEqual(writes.length, 0, 'cancelling the save dialog must not write');",
      "  const target = uri(path.join(root, 'chosen CIT', 'hammer.properties')); saveTarget = target;",
      "  assert.strictEqual(await command(), target);",
      "  assert.strictEqual(saveOptions.length, 2);",
      "  assert.strictEqual(saveOptions[0].title, 'Generate CIT for current item');",
      "  assert.deepStrictEqual(saveOptions[0].filters, { 'CIT properties': ['properties'] });",
      "  assert.strictEqual(saveOptions[0].defaultUri.fsPath, path.join(root, 'assets', 'demo', 'citresewn', 'cit', 'hammer.properties'));",
      "  assert.deepStrictEqual(directories.map(item => item.fsPath), [path.dirname(target.fsPath)]);",
      "  assert.strictEqual(writes.length, 1);",
      "  assert.strictEqual(writes[0][0], target);",
      "  assert.strictEqual(writes[0][1].toString('utf8'), 'type=item\\nitems=demo:hammer\\nmodel=demo:item/hammer\\n');",
      "  assert.strictEqual(opened.length, 1);",
      "  assert.deepStrictEqual(shown, [opened[0]]);",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");

    const result = runTestProcessSync(process.execPath, ["-e", script, commandPath]);
    assertTestProcessStatus(result);
  });
});
