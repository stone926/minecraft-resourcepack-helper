import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

describe("resource search webview", () => {
  it("isolates recreated view sessions and defers hidden invalidations", () => {
    const modulePath = path.join(
      process.cwd(),
      "out",
      "src",
      "views",
      "resourceSearchView.js"
    );
    const script = [
      "const assert = require('node:assert');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const modulePath = process.argv[1];",
      "const format = (value, args) => args.reduce((text, arg, index) => text.replace(`{${index}}`, String(arg)), value);",
      "const vscode = { l10n: { t: (value, ...args) => format(value, args) }, env: { language: 'en' } };",
      "Module._load = function(request, ...args) {",
      "  return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args);",
      "};",
      "function emitter() {",
      "  const listeners = new Set();",
      "  return {",
      "    event: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },",
      "    fire: value => { for (const listener of [...listeners]) listener(value); }",
      "  };",
      "}",
      "function createView() {",
      "  const messages = emitter(); const visibility = emitter(); const disposal = emitter(); const posted = [];",
      "  const view = {",
      "    visible: true,",
      "    webview: {",
      "      options: {}, html: '', onDidReceiveMessage: messages.event,",
      "      postMessage: async message => { posted.push(message); return true; }",
      "    },",
      "    onDidChangeVisibility: visibility.event,",
      "    onDidDispose: disposal.event",
      "  };",
      "  return { view, posted, message: messages.fire, visibility: visibility.fire, dispose: disposal.fire };",
      "}",
      "let resolveOld; const oldSearch = new Promise(resolve => { resolveOld = resolve; });",
      "let invalidationListener;",
      "const controller = {",
      "  searchResources: request => request.query === 'old'",
      "    ? oldSearch",
      "    : Promise.resolve({ matches: [], coverage: 'authoritative' }),",
      "  onDidInvalidateSearch: listener => { invalidationListener = listener; return { dispose() {} }; },",
      "  navigateNode: async () => undefined",
      "};",
      "const { ResourceSearchViewProvider } = require(modulePath);",
      "const provider = new ResourceSearchViewProvider(() => controller);",
      "const first = createView(); provider.resolveWebviewView(first.view);",
      "first.message({ type: 'search', requestId: 7, query: 'old', kinds: ['model'] });",
      "const second = createView(); provider.resolveWebviewView(second.view);",
      "second.message({ type: 'search', requestId: 1, query: 'new', kinds: ['model'] });",
      "const turn = () => new Promise(resolve => setImmediate(resolve));",
      "(async () => {",
      "  await turn();",
      "  assert.ok(second.posted.some(message => message.type === 'searchResult' && message.requestId === 1));",
      "  resolveOld({ matches: [], coverage: 'authoritative' });",
      "  await turn();",
      "  assert.strictEqual(second.posted.some(message => message.requestId === 7), false);",
      "  second.view.visible = false;",
      "  invalidationListener();",
      "  await turn();",
      "  assert.strictEqual(second.posted.some(message => message.type === 'invalidate'), false);",
      "  second.view.visible = true;",
      "  second.visibility();",
      "  await turn();",
      "  assert.strictEqual(second.posted.filter(message => message.type === 'invalidate').length, 1);",
      "  provider.dispose();",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");

    const result = spawnSync(process.execPath, ["-e", script, modulePath], {
      encoding: "utf8"
    });

    assert.strictEqual(result.status, 0, result.stderr);
  });
});
