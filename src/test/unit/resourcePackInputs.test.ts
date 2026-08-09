import { resolveFreshCompiledModule } from "../../../test/helpers/compiledHarness";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../../../test/helpers/testProcess";

describe("resource pack inputs", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("collects shared attributes with one validation and cancellation policy", () => {
    const modulePath = resolveFreshCompiledModule("src/commands/resourcePackInputs.ts");
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "let answers = []; const calls = [];",
      "const vscode = {",
      "  l10n: { t: (value, ...args) => typeof value === 'string' ? value.replace('{0}', args[0] ?? '') : value.message },",
      "  window: { showInputBox: async options => { calls.push(options); return answers.shift(); } }",
      "};",
      "Module._load = function(request, ...args) { if (request === 'vscode') return vscode; return originalLoad.call(this, request, ...args); };",
      "const { collectResourcePackAttributes } = require(process.argv[1]);",
      "(async () => {",
      "  answers = ['custom', '88.0', 'A pack'];",
      "  assert.deepStrictEqual(await collectResourcePackAttributes(), { namespace: 'custom', packFormat: '88.0', description: 'A pack' });",
      "  assert.strictEqual(calls.length, 3);",
      "  assert.strictEqual(calls[0].validateInput('   '), 'input must not be empty');",
      "  assert.strictEqual(calls[0].validateInput('demo'), null);",
      "  assert.strictEqual(calls[1].validateInput('88.x'), 'input must be a pack format version such as 88.0 or 69');",
      "  assert.strictEqual(calls[1].validateInput('69'), null);",
      "  calls.length = 0; answers = ['custom', undefined];",
      "  assert.strictEqual(await collectResourcePackAttributes(), null);",
      "  assert.strictEqual(calls.length, 2);",
      "  calls.length = 0; answers = [undefined];",
      "  assert.strictEqual(await collectResourcePackAttributes(), null);",
      "  assert.strictEqual(calls.length, 1);",
      "  calls.length = 0; answers = ['custom', '88.0', undefined];",
      "  assert.strictEqual(await collectResourcePackAttributes(), null);",
      "  assert.strictEqual(calls.length, 3);",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join('\n');

    assertTestProcessStatus(runTestProcessSync(process.execPath, ["-e", script, modulePath]));
  });
});
