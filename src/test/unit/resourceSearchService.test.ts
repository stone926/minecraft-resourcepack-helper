import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

describe("resource search service", () => {
  it("caches discovery, scopes projects, and ignores its own provider replacements", () => {
    const modulePath = path.join(
      process.cwd(),
      "out",
      "src",
      "services",
      "resourceSearchService.js"
    );
    const script = [
      "const assert = require('node:assert');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const modulePath = process.argv[1];",
      "let findCalls = 0; let folderListener; let folderSubscriptionDisposed = false;",
      "const uri = value => ({ fsPath: value, path: value, toString: () => `file:///${value}` });",
      "const vscode = {",
      "  workspace: {",
      "    workspaceFolders: [{ uri: uri('workspace') }],",
      "    findFiles: async () => { findCalls++; return [uri('workspace/rsgl.config.json')]; },",
      "    onDidChangeWorkspaceFolders: listener => {",
      "      folderListener = listener;",
      "      return { dispose: () => { folderSubscriptionDisposed = true; } };",
      "    }",
      "  }",
      "};",
      "Module._load = function(request, ...args) {",
      "  return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args);",
      "};",
      "const { ResourceSearchService } = require(modulePath);",
      "let service; let selfChangeSent = false; let ensureCalls = 0; const inventoryCalls = [];",
      "const navigation = {",
      "  ensureProjectForUri: async () => {",
      "    ensureCalls++;",
      "    if (!selfChangeSent) { selfChangeSent = true; service.resourcesChanged(); }",
      "    return { context: { projectId: 'project' }, coverage: 'authoritative' };",
      "  },",
      "  getKnownResources: async (kinds, options) => {",
      "    inventoryCalls.push({ kinds: [...kinds], projectIds: [...(options.projectIds || [])] });",
      "    return { resources: [], coverage: 'authoritative' };",
      "  }",
      "};",
      "service = new ResourceSearchService(navigation);",
      "let invalidations = 0; service.onDidInvalidate(() => invalidations++);",
      "const request = { query: 'stone', kinds: ['model'] };",
      "(async () => {",
      "  await service.search(request);",
      "  await service.search(request);",
      "  assert.strictEqual(findCalls, 1);",
      "  assert.strictEqual(ensureCalls, 2);",
      "  assert.deepStrictEqual(inventoryCalls, [{ kinds: ['blockstate', 'model', 'texture'], projectIds: ['project'] }]);",
      "  assert.strictEqual(invalidations, 0, 'provider changes caused by ensure must not force a second load');",
      "  service.resourcesChanged();",
      "  assert.strictEqual(invalidations, 1);",
      "  await service.search(request);",
      "  assert.strictEqual(findCalls, 1, 'ordinary resource changes reuse project discovery');",
      "  assert.strictEqual(inventoryCalls.length, 2);",
      "  service.invalidateProjectDiscoveryForPath('workspace/pack.mcmeta');",
      "  assert.strictEqual(invalidations, 2);",
      "  await service.search(request);",
      "  assert.strictEqual(findCalls, 2, 'project metadata changes invalidate anchor discovery');",
      "  service.invalidateProjectDiscovery();",
      "  assert.strictEqual(invalidations, 3);",
      "  await service.search(request);",
      "  assert.strictEqual(findCalls, 3, 'explicit project discovery invalidation rescans anchors');",
      "  folderListener();",
      "  assert.strictEqual(invalidations, 4);",
      "  service.dispose();",
      "  assert.strictEqual(folderSubscriptionDisposed, true);",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");

    const result = spawnSync(process.execPath, ["-e", script, modulePath], {
      encoding: "utf8"
    });

    assert.strictEqual(result.status, 0, result.stderr);
  });
});
