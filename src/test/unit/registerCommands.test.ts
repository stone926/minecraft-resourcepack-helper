import { resolveFreshCompiledModule } from "../../../test/helpers/compiledHarness";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../../../test/helpers/testProcess";

describe("command registration", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("registers the owned command surface, delegates handlers, and exposes every disposable", () => {
    const registrationPath = resolveFreshCompiledModule("src/registration/registerCommands.ts");
    const runtimePath = resolveFreshCompiledModule(
      "src/modelPreview/commands/modelPreviewCommandRuntime.ts"
    );
    const createPackPath = resolveFreshCompiledModule("src/commands/createNewResourcePack.ts");
    const createPackRootPath = resolveFreshCompiledModule("src/commands/createNewResourcePackRoot.ts");
    const createMissingCitPath = resolveFreshCompiledModule(
      "src/cit/commands/createMissingCitResource.ts"
    );
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const [registrationPath, runtimePath, createPackPath, createPackRootPath, createMissingCitPath] = process.argv.slice(1);",
      "const handlers = new Map(); const disposed = []; const directCalls = [];",
      "const direct = name => (...args) => { directCalls.push([name, args]); return `${name}-result`; };",
      "const openDefault = direct('openDefault');",
      "const createPack = direct('createPack');",
      "const createPackRoot = direct('createPackRoot');",
      "const createCit = direct('createCit');",
      "const generateCit = direct('generateCit');",
      "const createMissingCit = direct('createMissingCit');",
      "const informationMessages = []; const executed = [];",
      "const vscode = {",
      "  commands: {",
      "    registerCommand: (id, handler) => {",
      "      assert.strictEqual(handlers.has(id), false, `duplicate command ${id}`);",
      "      handlers.set(id, handler);",
      "      return { dispose: () => { disposed.push(id); handlers.delete(id); } };",
      "    },",
      "    executeCommand: async (...args) => { executed.push(args); }",
      "  },",
      "  l10n: { t: value => value },",
      "  window: { showInformationMessage: async message => { informationMessages.push(message); return message; } }",
      "};",
      "const directStubs = new Map([",
      "  ['../cit/commands/createCitTemplate', createCit],",
      "  ['../cit/commands/generateCitForCurrentItem', generateCit],",
      "  ['../commands/openDefaultMcAssetsPath', openDefault]",
      "]);",
      "Module._load = function(request, parent, ...args) {",
      "  if (request === 'vscode') return vscode;",
      "  if (parent?.filename === registrationPath) {",
      "    if (directStubs.has(request)) return directStubs.get(request);",
      "    if (request === '../services/workspaceResourceCache') return { workspaceResourceCache: { getStats: () => ({ hits: 7, misses: 2 }) } };",
      "  }",
      "  return originalLoad.call(this, request, parent, ...args);",
      "};",
      "const runtimeCalls = []; let runtimeFactoryCalls = 0; let runtimeExtensionUri;",
      "const runtime = {",
      "  open: (...args) => { runtimeCalls.push(['open', args]); return 'open-result'; },",
      "  openGraphNode: (...args) => { runtimeCalls.push(['openGraphNode', args]); return 'graph-result'; },",
      "  exportImage: (...args) => { runtimeCalls.push(['exportImage', args]); return 'export-result'; },",
      "  captureImage: (...args) => { runtimeCalls.push(['captureImage', args]); return 'capture-result'; }",
      "};",
      "require.cache[runtimePath] = {",
      "  id: runtimePath, filename: runtimePath, loaded: true, children: [], paths: [],",
      "  exports: { createModelPreviewCommandRuntime: extensionUri => { runtimeFactoryCalls++; runtimeExtensionUri = extensionUri; return runtime; } }",
      "};",
      "require.cache[createPackPath] = { id: createPackPath, filename: createPackPath, loaded: true, children: [], paths: [], exports: { createNewResourcePack: createPack } };",
      "require.cache[createPackRootPath] = { id: createPackRootPath, filename: createPackRootPath, loaded: true, children: [], paths: [], exports: { createNewResourcePackRoot: createPackRoot } };",
      "require.cache[createMissingCitPath] = { id: createMissingCitPath, filename: createMissingCitPath, loaded: true, children: [], paths: [], exports: { createMissingCitResource: createMissingCit } };",
      "const extensionUri = { value: 'file:///extension', toString: () => 'file:///extension' };",
      "const context = { extensionUri, subscriptions: [] };",
      "require(registrationPath).registerCommands(context);",
      "const expected = [",
      "  'McResHelper.openDefaultMcAssetsPath',",
      "  'McResHelper.createNewResourcePack',",
      "  'McResHelper.createNewResourcePackRoot',",
      "  'McResHelper.createCitTemplate',",
      "  'McResHelper.generateCitForCurrentItem',",
      "  'McResHelper.createMissingCitResource',",
      "  'McResHelper.openModelPreview',",
      "  'McResHelper.openResourceGraphModelPreview',",
      "  'McResHelper.openUnsupportedModelPreviewResource',",
      "  'McResHelper.exportModelPreviewImage',",
      "  'McResHelper.captureModelPreviewImage',",
      "  'McResHelper.showWorkspaceResourceCacheStats',",
      "  'McResHelper.triggerResourceCompletion'",
      "];",
      "assert.deepStrictEqual([...handlers.keys()].sort(), [...expected].sort());",
      "assert.strictEqual(context.subscriptions.length, expected.length);",
      "assert.strictEqual(handlers.get('McResHelper.openDefaultMcAssetsPath'), openDefault);",
      "assert.strictEqual(handlers.get('McResHelper.createCitTemplate'), createCit);",
      "assert.strictEqual(handlers.get('McResHelper.generateCitForCurrentItem'), generateCit);",
      "const timerTurn = () => new Promise(resolve => setTimeout(resolve, 0));",
      "(async () => {",
      "  assert.strictEqual(await handlers.get('McResHelper.createNewResourcePack')(), 'createPack-result');",
      "  assert.strictEqual(await handlers.get('McResHelper.createNewResourcePackRoot')(), 'createPackRoot-result');",
      "  assert.strictEqual(await handlers.get('McResHelper.createMissingCitResource')('uri', 2), 'createMissingCit-result');",
      "  assert.strictEqual(await handlers.get('McResHelper.openModelPreview')('model', 1), 'open-result');",
      "  assert.strictEqual(await handlers.get('McResHelper.openResourceGraphModelPreview')({ id: 'node' }), 'graph-result');",
      "  assert.strictEqual(await handlers.get('McResHelper.exportModelPreviewImage')('png'), 'export-result');",
      "  assert.strictEqual(await handlers.get('McResHelper.captureModelPreviewImage')('capture'), 'capture-result');",
      "  assert.strictEqual(runtimeFactoryCalls, 1, 'model preview commands must share one lazy runtime');",
      "  assert.strictEqual(runtimeExtensionUri, extensionUri);",
      "  assert.deepStrictEqual(runtimeCalls, [",
      "    ['open', ['model', 1]], ['openGraphNode', [{ id: 'node' }]],",
      "    ['exportImage', ['png']], ['captureImage', ['capture']]",
      "  ]);",
      "  assert.deepStrictEqual(directCalls, [",
      "    ['createPack', []], ['createPackRoot', []], ['createMissingCit', ['uri', 2]]",
      "  ]);",
      "  await handlers.get('McResHelper.openUnsupportedModelPreviewResource')();",
      "  await handlers.get('McResHelper.showWorkspaceResourceCacheStats')();",
      "  assert.deepStrictEqual(informationMessages, [",
      "    'Model preview supports model JSON resources only for now',",
      "    JSON.stringify({ hits: 7, misses: 2 })",
      "  ]);",
      "  handlers.get('McResHelper.triggerResourceCompletion')();",
      "  await timerTurn();",
      "  assert.deepStrictEqual(executed, [['editor.action.triggerSuggest']]);",
      "  for (const disposable of [...context.subscriptions].reverse()) disposable.dispose();",
      "  assert.strictEqual(handlers.size, 0);",
      "  assert.deepStrictEqual([...disposed].sort(), [...expected].sort());",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");

    const result = runTestProcessSync(
      process.execPath,
      [
        "-e",
        script,
        registrationPath,
        runtimePath,
        createPackPath,
        createPackRootPath,
        createMissingCitPath
      ]
    );
    assertTestProcessStatus(result);
  });
});
