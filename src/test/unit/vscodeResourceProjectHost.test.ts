import { resolveFreshCompiledModule } from "../../../test/helpers/compiledHarness";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../../../test/helpers/testProcess";

describe("VS Code resource project host", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("reuses workspace configuration until an explicit invalidation", () => {
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const folderUri = { toString: () => 'file:///workspace' };",
      "let vanilla = 'vanilla-a'; let custom = ['custom-a']; let configurationReads = 0;",
      "const workspace = { workspaceFolders: [{ uri: folderUri }], getConfiguration: () => {",
      "  configurationReads++; return {",
      "    inspect: section => section === 'McResHelper.vanillaResourcePackPath' || section === 'McResHelper.customResourcePackPaths' ? { workspaceFolderValue: true } : undefined,",
      "    get: section => section === 'McResHelper.vanillaResourcePackPath' ? vanilla : section === 'McResHelper.customResourcePackPaths' ? custom : undefined",
      "  };",
      "} };",
      "Module._load = function(request, ...args) { if (request === 'vscode') return { workspace }; return originalLoad.call(this, request, ...args); };",
      "const { VscodeResourcePackProjectHost } = require(process.argv[1]);",
      "const host = new VscodeResourcePackProjectHost();",
      "const first = host.getWorkspaceFolders(); const repeated = host.getWorkspaceFolders();",
      "assert.strictEqual(repeated, first); assert.strictEqual(configurationReads, 1);",
      "assert.strictEqual(first[0].sharedConfiguration.vanillaLayer.root, 'file:///workspace/vanilla-a');",
      "assert.deepStrictEqual(first[0].sharedConfiguration.externalLayers.map(layer => layer.root), ['file:///workspace/custom-a']);",
      "vanilla = 'vanilla-b'; custom = ['custom-b'];",
      "assert.strictEqual(host.getWorkspaceFolders(), first); assert.strictEqual(configurationReads, 1);",
      "host.invalidateWorkspaceFolders(); const refreshed = host.getWorkspaceFolders();",
      "assert.notStrictEqual(refreshed, first); assert.strictEqual(configurationReads, 2);",
      "assert.strictEqual(refreshed[0].sharedConfiguration.vanillaLayer.root, 'file:///workspace/vanilla-b');",
      "assert.deepStrictEqual(refreshed[0].sharedConfiguration.externalLayers.map(layer => layer.root), ['file:///workspace/custom-b']);",
      "assert.notStrictEqual(refreshed[0].configurationRevision, first[0].configurationRevision);"
    ].join("\n");
    const hostPath = resolveFreshCompiledModule(
      "src/resourceProject/vscodeResourceProjectHost.ts"
    );
    const result = runTestProcessSync(process.execPath, ["-e", script, hostPath]);
    assertTestProcessStatus(result);
  });
});
