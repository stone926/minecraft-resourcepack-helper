import { resolveFreshCompiledModule } from "../../../test/helpers/compiledHarness";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../../../test/helpers/testProcess";

describe("RSGL build presenter", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("opens conflict previews even when materialization diagnostics are errors", () => {
    const modulePath = resolveFreshCompiledModule("src/rsgl/host/commands/buildPresenter.ts");
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const modulePath = process.argv[1];",
      "const errors = []; const opened = []; const shown = [];",
      "const format = (value, args) => args.reduce((text, arg, index) => text.replace(`{${index}}`, String(arg)), value);",
      "const vscode = {",
      "  l10n: { t: (value, ...args) => format(value, args) },",
      "  workspace: { openTextDocument: async options => { opened.push(options); return options; } },",
      "  window: {",
      "    showErrorMessage: async message => { errors.push(message); },",
      "    showInformationMessage: async () => undefined,",
      "    showTextDocument: async document => { shown.push(document); },",
      "    withProgress: async (_options, task) => task({ isCancellationRequested: false })",
      "  },",
      "  ProgressLocation: { Notification: 15 }",
      "};",
      "Module._load = function(request, ...args) {",
      "  return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args);",
      "};",
      "const { showBuildPreview, showWorkspaceBuildPreview } = require(modulePath);",
      "const diagnostic = { severity: 'error', code: 'rsgl.materializationConflict', message: 'conflict', range: { start: 0, end: 0 } };",
      "(async () => {",
      "  await showBuildPreview({ diagnostics: [diagnostic], dependencies: [], preview: '# Conflicts' });",
      "  assert.strictEqual(errors.length, 1);",
      "  assert.strictEqual(opened.length, 1);",
      "  assert.strictEqual(opened[0].content, '# Conflicts');",
      "  await showBuildPreview({ diagnostics: [diagnostic], dependencies: [] });",
      "  assert.strictEqual(errors.length, 2);",
      "  assert.strictEqual(opened.length, 1, 'compile errors without a preview should stop');",
      "  await showWorkspaceBuildPreview([{",
      "    context: { sourceRoot: 'rsgl', sourceFileName: 'rsgl/main.rsgl', outputRoot: 'pack' },",
      "    result: { diagnostics: [diagnostic], dependencies: [], preview: '# Conflicts' }",
      "  }], []);",
      "  assert.strictEqual(errors.length, 3);",
      "  assert.strictEqual(opened.length, 2);",
      "  assert.match(opened[1].content, /Conflicts/);",
      "  assert.strictEqual(shown.length, 2);",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");

    const result = runTestProcessSync(process.execPath, ["-e", script, modulePath]);

    assertTestProcessStatus(result);
  });
});
