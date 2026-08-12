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
      "const uri = value => ({ value, scheme: value.slice(0, value.indexOf(':')), path: value.slice(value.indexOf(':') + 1), fsPath: value.slice(value.indexOf(':') + 1), query: '', fragment: '', toString: () => value });",
      "const joinUri = (base, ...segments) => uri(base.toString().replace(/\\/$/, '') + '/' + segments.join('/'));",
      "let statMode = 'ready'; let metadataMode = 'missing'; let statCalls = 0; let metadataReads = 0; let abortOnStat; let invalidateOnStat; let directoryEntries = new Map();",
      "const workspace = { textDocuments: [{ uri: uri('vscode-remote://ssh-remote+dev/work/%E8%B5%84%E6%BA%90/assets/demo/models/block/open.json') }], fs: {",
      "  stat: async target => { statCalls++; if (statMode === 'missing') throw new FileSystemError('FileNotFound'); if (statMode === 'unavailable') throw new Error('provider offline'); if (abortOnStat) { abortOnStat.abort(); abortOnStat = undefined; } if (invalidateOnStat) { const invalidate = invalidateOnStat; invalidateOnStat = undefined; invalidate(); } return { type: statMode === 'unknown' ? 0 : target.toString().endsWith('.json') ? 1 : 2 }; },",
      "  readFile: async target => { if (!target.toString().endsWith('pack.mcmeta')) return Buffer.from('{}'); metadataReads++; if (metadataMode === 'missing') throw new FileSystemError('FileNotFound'); if (metadataMode === 'unavailable') throw new Error('provider offline'); if (metadataMode === 'overlay') return Buffer.from(JSON.stringify({ overlays: { entries: [{ directory: 'overlay', formats: { min_inclusive: 1, max_inclusive: 999 } }] } })); return Buffer.from('{}'); },",
      "  readDirectory: async target => directoryEntries.get(target.toString()) ?? []",
      "} };",
      "Module._load = function(request, ...args) { if (request === 'vscode') return { Uri: { parse: uri, joinPath: joinUri }, FileType: { File: 1, Directory: 2 }, FileSystemError, workspace }; return originalLoad.call(this, request, ...args); };",
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
      "  const cachedStatCalls = statCalls; const cachedMetadataReads = metadataReads;",
      "  assert.deepStrictEqual(await source.getOrderedAssetsRootUris(context, localLayer), { status: 'ready', assetsRootUris: ['file:///pack/assets'] });",
      "  assert.strictEqual(statCalls, cachedStatCalls); assert.strictEqual(metadataReads, cachedMetadataReads);",
      "  source.invalidateProjects(['project']);",
      "  await source.getOrderedAssetsRootUris(context, localLayer);",
      "  assert.ok(statCalls > cachedStatCalls); assert.ok(metadataReads > cachedMetadataReads);",
      "  source.invalidateProjects(['project']);",
      "  const exactRequest = { context, target: { kind: 'model', id: 'demo:block/repeated' }, scope: 'effective' };",
      "  const firstExact = await source.resolveExactDefinition(exactRequest); const exactStatCalls = statCalls; const exactMetadataReads = metadataReads;",
      "  assert.strictEqual(firstExact.status, 'resolved'); assert.strictEqual(firstExact.definition.layer.layerId, 'local');",
      "  const secondExact = await source.resolveExactDefinition(exactRequest);",
      "  assert.deepStrictEqual(secondExact, firstExact); assert.strictEqual(statCalls, exactStatCalls); assert.strictEqual(metadataReads, exactMetadataReads);",
      "  source.invalidateProjects(['project']); await source.resolveExactDefinition(exactRequest);",
      "  assert.ok(statCalls > exactStatCalls); assert.ok(metadataReads > exactMetadataReads);",
      "  source.invalidateProjects(['project']);",
      "  const racingRequest = { context, target: { kind: 'model', id: 'demo:block/racing' }, scope: 'effective' };",
      "  invalidateOnStat = () => source.invalidateProjects(['project']);",
      "  await source.resolveExactDefinition(racingRequest); const racingStatCalls = statCalls;",
      "  await source.resolveExactDefinition(racingRequest);",
      "  assert.ok(statCalls > racingStatCalls, 'an invalidated in-flight probe must not repopulate the exact cache');",
      "  source.invalidateProjects(['project']); metadataMode = 'overlay';",
      "  const roots = ['file:///pack/overlay/assets', 'file:///pack/assets']; directoryEntries = new Map();",
      "  for (const root of roots) { directoryEntries.set(root, [['demo', 2]]); directoryEntries.set(root + '/demo', [['models', 2]]); directoryEntries.set(root + '/demo/models', [['block', 2]]); directoryEntries.set(root + '/demo/models/block', [['winner.json', 1]]); }",
      "  const overlayScan = await source.scanProject({ projectId: 'project', scope: { projectId: 'project' } }, new AbortController().signal);",
      "  assert.strictEqual(overlayScan.coverage.status, 'authoritative'); assert.deepStrictEqual(overlayScan.documents.map(document => document.uri), ['file:///pack/overlay/assets/demo/models/block/winner.json'], 'full snapshots must keep the same first-root winner as exact Definition');",
      "  directoryEntries.set('file:///pack/overlay/assets/demo/models/block', []);",
      "  workspace.textDocuments = [{ uri: uri('file:///pack/overlay/assets/demo/models/block/winner.json'), fileName: '/pack/overlay/assets/demo/models/block/winner.json', languageId: 'json', version: 1, getText: () => '{}' }];",
      "  const openOverlayScan = await source.scanProject({ projectId: 'project', scope: { projectId: 'project' } }, new AbortController().signal);",
      "  assert.deepStrictEqual(openOverlayScan.documents.map(document => document.uri), ['file:///pack/overlay/assets/demo/models/block/winner.json'], 'an open overlay document must outrank an enumerated base file');",
      "  workspace.textDocuments = [];",
      "  source.invalidateProjects(['project']);",
      "  const cancellation = new AbortController(); abortOnStat = cancellation;",
      "  await assert.rejects(source.getOrderedAssetsRootUris(context, localLayer, cancellation.signal), error => error?.name === 'AbortError');",
      "  metadataMode = 'unavailable'; directoryEntries = new Map();",
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
