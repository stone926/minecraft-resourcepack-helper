import {
  resolveFreshCompiledModule
} from "../../../test/helpers/compiledHarness";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../../../test/helpers/testProcess";

describe("resource configuration migration", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("prefers explicitly configured canonical keys and otherwise falls back to legacy keys", () => {
    const modulePath = resolveFreshCompiledModule("src/utils/resourceConfiguration.ts");
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const values = new Map([",
      "  ['McResHelper.defaultMcAssetsPath', 'C:/legacy/vanilla'],",
      "  ['McResHelper.resourcePackLoadOrder', ['C:/legacy/high', 'C:/legacy/low']]",
      "]);",
      "const explicit = new Set(); const scopes = [];",
      "const configuration = {",
      "  get: key => values.get(key),",
      "  inspect: key => explicit.has(key) ? { workspaceValue: values.get(key) } : { defaultValue: undefined }",
      "};",
      "const vscode = { workspace: { getConfiguration: (section, scope) => {",
      "  assert.strictEqual(section, undefined); scopes.push(scope); return configuration;",
      "} } };",
      "Module._load = function(request, ...args) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args); };",
      "const reader = require(process.argv[1]);",
      "assert.deepStrictEqual(reader.getResourceConfiguration('folder-scope'), {",
      "  defaultAssetsPath: 'C:/legacy/vanilla',",
      "  resourcePackRoots: ['C:/legacy/high', 'C:/legacy/low']",
      "});",
      "values.set('McResHelper.vanillaResourcePackPath', 'C:/canonical/vanilla');",
      "values.set('McResHelper.customResourcePackPaths', ['C:/canonical/custom']);",
      "explicit.add('McResHelper.vanillaResourcePackPath');",
      "explicit.add('McResHelper.customResourcePackPaths');",
      "assert.deepStrictEqual(reader.getResourceConfiguration(), {",
      "  defaultAssetsPath: 'C:/canonical/vanilla',",
      "  resourcePackRoots: ['C:/canonical/custom']",
      "});",
      "values.set('McResHelper.vanillaResourcePackPath', '');",
      "values.set('McResHelper.customResourcePackPaths', []);",
      "assert.deepStrictEqual(reader.getResourceConfiguration(), { defaultAssetsPath: null, resourcePackRoots: [] });",
      "assert.strictEqual(scopes[0], 'folder-scope');"
    ].join("\n");

    const result = runTestProcessSync(process.execPath, ["-e", script, modulePath]);
    assertTestProcessStatus(result);
  });
});
