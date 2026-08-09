import { resolveFreshCompiledModule } from "../../../test/helpers/compiledHarness";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../../../test/helpers/testProcess";

describe("VS Code physical asset source exact resolution", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("uses canonical open-document identity and falls back on incomplete filesystem evidence", () => {
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "class FileSystemError extends Error { constructor(code) { super(code); this.code = code; } }",
      "const uri = value => ({ value, scheme: value.slice(0, value.indexOf(':')), path: value.slice(value.indexOf(':') + 1), fsPath: value.slice(value.indexOf(':') + 1), toString: () => value });",
      "let statMode = 'ready'; let metadataMode = 'missing'; let statCalls = 0; let abortOnStat;",
      "const workspace = { textDocuments: [{ uri: uri('vscode-remote://ssh-remote+dev/work/%E8%B5%84%E6%BA%90/assets/demo/models/block/open.json') }], fs: {",
      "  stat: async () => { statCalls++; if (statMode === 'missing') throw new FileSystemError('FileNotFound'); if (statMode === 'unavailable') throw new Error('provider offline'); if (abortOnStat) { abortOnStat.abort(); abortOnStat = undefined; } return { type: statMode === 'unknown' ? 0 : 2 }; },",
      "  readFile: async () => { if (metadataMode === 'missing') throw new FileSystemError('FileNotFound'); if (metadataMode === 'unavailable') throw new Error('provider offline'); return Buffer.from('{}'); },",
      "  readDirectory: async () => []",
      "} };",
      "Module._load = function(request, ...args) { if (request === 'vscode') return { Uri: { parse: uri }, FileType: { File: 1, Directory: 2 }, FileSystemError, workspace }; return originalLoad.call(this, request, ...args); };",
      "const { VscodePhysicalAssetSource } = require(process.argv[1]);",
      "const localLayer = { layerId: 'local', role: 'local', source: 'directory', rootUri: 'file:///pack', priority: 0, metadataRevision: 'm1' };",
      "const context = { projectId: 'project', workspaceFolderUri: 'file:///pack', projectRootUri: 'file:///pack', packRootUri: 'file:///pack', assetsRootUri: 'file:///pack/assets', rsglSourceRootUris: ['file:///pack/rsgl'], outputPackRootUri: 'file:///pack', outputAssetsRootUri: 'file:///pack/assets', localLayer, externalLayers: [], overlaySelection: [], configurationRevision: 'c1', contextRevision: 'r1' };",
      "const source = new VscodePhysicalAssetSource({ getCachedContext: () => context });",
      "(async () => {",
      "  const open = await source.probeTargetUri('vscode-remote://ssh-remote+dev/work/%e8%b5%84%e6%ba%90/assets/demo/models/block/open.json');",
      "  assert.strictEqual(open, 'file'); assert.strictEqual(statCalls, 0);",
      "  workspace.textDocuments = []; statMode = 'missing';",
      "  assert.strictEqual(await source.probeTargetUri('file:///pack/missing.json'), 'missing');",
      "  statMode = 'unavailable';",
      "  assert.strictEqual(await source.probeTargetUri('file:///pack/offline.json'), 'unavailable');",
      "  statMode = 'unknown';",
      "  assert.strictEqual(await source.probeTargetUri('file:///pack/unknown.json'), 'unavailable');",
      "  statMode = 'ready'; metadataMode = 'unavailable';",
      "  assert.deepStrictEqual(await source.getOrderedAssetsRootUris(context, localLayer), { status: 'unavailable' });",
      "  metadataMode = 'missing';",
      "  assert.deepStrictEqual(await source.getOrderedAssetsRootUris(context, localLayer), { status: 'ready', assetsRootUris: ['file:///pack/assets'] });",
      "  const cancellation = new AbortController(); abortOnStat = cancellation;",
      "  await assert.rejects(source.getOrderedAssetsRootUris(context, localLayer, cancellation.signal), error => error?.name === 'AbortError');",
      "  metadataMode = 'unavailable';",
      "  const scan = await source.scanProject({ projectId: 'project', scope: { projectId: 'project' } }, new AbortController().signal);",
      "  assert.strictEqual(scan.coverage.status, 'partial');",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");
    const sourcePath = resolveFreshCompiledModule(
      "src/resourceUniverse/providers/vscodePhysicalAssetSource.ts"
    );
    const result = runTestProcessSync(process.execPath, ["-e", script, sourcePath]);
    assertTestProcessStatus(result);
  });
});
