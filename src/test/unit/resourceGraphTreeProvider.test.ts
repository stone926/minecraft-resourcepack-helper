import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

describe("resource graph tree provider", () => {
  it("keeps a searched focus stable across active-editor changes", () => {
    const modulePath = path.join(
      process.cwd(),
      "out",
      "src",
      "views",
      "resourceGraphTree.js"
    );
    const script = [
      "const assert = require('node:assert');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const modulePath = process.argv[1];",
      "class EventEmitter {",
      "  constructor() { this.listeners = new Set(); this.event = listener => {",
      "    this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) };",
      "  }; }",
      "  fire(value) { for (const listener of [...this.listeners]) listener(value); }",
      "  dispose() { this.listeners.clear(); }",
      "}",
      "class TreeItem {} class ThemeIcon {}",
      "const activeDocument = { fileName: 'active.json', uri: { scheme: 'file', fsPath: 'active.json' } };",
      "const vscode = {",
      "  EventEmitter, TreeItem, ThemeIcon,",
      "  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },",
      "  l10n: { t: value => value },",
      "  window: { activeTextEditor: { document: activeDocument } },",
      "  Uri: class Uri {}",
      "};",
      "Module._load = function(request, ...args) {",
      "  return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args);",
      "};",
      "const calls = [];",
      "const model = {",
      "  invalidate() {},",
      "  getRoots: async (document, resource) => { calls.push({ document, resource }); return []; }",
      "};",
      "const focused = {",
      "  target: { kind: 'texture', id: 'demo:block/stone' },",
      "  producer: { producerId: 'physical:texture:stone' }",
      "};",
      "const rebound = { ...focused, producer: { ...focused.producer, revision: 'r2' } };",
      "const { ResourceGraphTreeProvider } = require(modulePath);",
      "let current = rebound;",
      "const provider = new ResourceGraphTreeProvider(model, (producerId, target) => {",
      "  assert.strictEqual(producerId, focused.producer.producerId);",
      "  assert.deepStrictEqual(target, focused.target);",
      "  return current;",
      "});",
      "let refreshes = 0; provider.onDidChangeTreeData(() => refreshes++);",
      "const focusStates = []; provider.onDidChangeFocus(value => focusStates.push(value));",
      "(async () => {",
      "  provider.refreshActiveEditor();",
      "  assert.strictEqual(refreshes, 1);",
      "  provider.focusResource(focused);",
      "  assert.strictEqual(refreshes, 2);",
      "  provider.refreshActiveEditor();",
      "  assert.strictEqual(refreshes, 2, 'focused relations should not follow editor churn');",
      "  await provider.getChildren();",
      "  assert.strictEqual(calls[0].resource, rebound, 'focus should rebind to the current producer snapshot');",
      "  assert.strictEqual(provider.followActiveEditor(), true);",
      "  provider.refreshActiveEditor();",
      "  assert.strictEqual(refreshes, 4);",
      "  await provider.getChildren();",
      "  assert.strictEqual(calls[1].document, activeDocument);",
      "  assert.strictEqual(calls[1].resource, undefined);",
      "  assert.strictEqual(provider.followActiveEditor(), false);",
      "  provider.focusResource(focused); current = undefined;",
      "  await provider.getChildren();",
      "  assert.strictEqual(calls[2].resource, undefined, 'removed producers should fall back to the active editor');",
      "  assert.deepStrictEqual(focusStates, [true, false, true, false]);",
      "  provider.dispose();",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");

    const result = spawnSync(process.execPath, ["-e", script, modulePath], {
      encoding: "utf8"
    });

    assert.strictEqual(result.status, 0, result.stderr);
  });
});
