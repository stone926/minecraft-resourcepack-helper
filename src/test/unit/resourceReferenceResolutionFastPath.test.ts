import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

describe("resource reference resolution fast path", () => {
  it("avoids physical and generated refreshes only when bounded evidence is authoritative", () => {
    const script = [
      "const assert = require('node:assert');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const uri = value => { const parsed = new URL(value); const filePath = decodeURIComponent(parsed.pathname); return { scheme: parsed.protocol.slice(0, -1), path: filePath, fsPath: filePath, toString: () => value }; };",
      "Module._load = function(request, ...args) { if (request === 'vscode') return { Uri: { parse: uri } }; return originalLoad.call(this, request, ...args); };",
      "const { ResourceUniverseNavigationFacade } = require(process.argv[1]);",
      "const layer = (layerId, role, source, rootUri, priority) => ({ layerId, role, source, rootUri, priority, metadataRevision: 'm1' });",
      "const base = { projectId: 'project', workspaceFolderUri: 'file:///pack', projectRootUri: 'file:///pack', packRootUri: 'file:///pack', assetsRootUri: 'file:///pack/assets', rsglSourceRootUris: [], outputPackRootUri: 'file:///pack', outputAssetsRootUri: 'file:///pack/assets', localLayer: layer('local', 'local', 'directory', 'file:///pack', 0), vanillaLayer: undefined, overlaySelection: [], configurationRevision: 'c1', contextRevision: 'r1' };",
      "const directoryContext = { ...base, externalLayers: [layer('directory', 'custom', 'directory', 'file:///layers/directory', 1)] };",
      "const archiveContext = { ...base, externalLayers: [layer('archive', 'custom', 'zip', 'file:///layers/lower.zip', 1)] };",
      "let context = directoryContext; let winnerEnabled = true; let physicalRefreshes = 0; let generatedRefreshes = 0; let universeResolutions = 0; let refreshed = false;",
      "const projects = { resolveProject: async () => ({ context, rsglApplicability: 'none' }), getRsglApplicability: () => 'none', findCachedContextsForUri: () => [], getCachedContexts: () => [] };",
      "const coverage = { status: 'authoritative', revision: 'physical-r1', coveredScope: { projectId: 'project' } };",
      "const index = { getCoverage: provider => provider === 'physical' && refreshed ? coverage : undefined, resolve: () => { universeResolutions++; return { status: 'missing', coverageComplete: true }; }, getProducersForKey: () => [] };",
      "const universe = { index, getCoverage: (provider, projectId) => index.getCoverage(provider, projectId), getProducersForKey: target => index.getProducersForKey(target), getProjectProducers: () => [], hasProvider: () => true, getRegisteredProvider: () => ({}), refreshProviderProject: async provider => { assert.strictEqual(provider, 'physical'); physicalRefreshes++; refreshed = true; return { applied: true }; }, invalidateProviderProject: () => undefined, onDidChange: () => ({ dispose() {} }) };",
      "const localWinner = uri('file:///pack/assets/demo/models/block/local.json');",
      "const facade = new ResourceUniverseNavigationFacade(projects, universe, () => winnerEnabled ? localWinner : null);",
      "facade.setGeneratedProjectRefresher(async () => { generatedRefreshes++; });",
      "const document = { uri: uri('file:///pack/assets/demo/models/block/consumer.json'), fileName: '/pack/assets/demo/models/block/consumer.json', languageId: 'json', getText: () => '{}' };",
      "const reference = { value: 'demo:block/local', valueNode: {}, target: 'models', source: 'assets', extension: 'json', kind: 'model' };",
      "(async () => {",
      "  let result = await facade.resolveReference(document, reference, { includeGenerated: true });",
      "  assert.strictEqual(result.targetUri, localWinner); assert.strictEqual(result.coverage, 'authoritative');",
      "  winnerEnabled = false; result = await facade.resolveReference(document, reference, { includeGenerated: true });",
      "  assert.strictEqual(result.targetUri, null); assert.strictEqual(result.coverage, 'authoritative');",
      "  context = archiveContext; winnerEnabled = true; result = await facade.resolveReference(document, reference, { includeGenerated: true });",
      "  assert.strictEqual(result.targetUri, localWinner, 'a local winner outranks the lower archive');",
      "  assert.deepStrictEqual({ physicalRefreshes, generatedRefreshes, universeResolutions }, { physicalRefreshes: 0, generatedRefreshes: 0, universeResolutions: 0 });",
      "  winnerEnabled = false; result = await facade.resolveReference(document, reference, { includeGenerated: true });",
      "  assert.strictEqual(result.targetUri, null); assert.strictEqual(result.navigation.status, 'missing');",
      "  assert.deepStrictEqual({ physicalRefreshes, generatedRefreshes, universeResolutions }, { physicalRefreshes: 1, generatedRefreshes: 0, universeResolutions: 1 });",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");
    const result = runFacadeScript(script);
    assert.strictEqual(result.status, 0, String(result.stderr));
  });

  it("resolves an exact RSGL physical Definition without refreshing the project index", () => {
    const script = [
      "const assert = require('node:assert');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const uri = value => { const parsed = new URL(value); const filePath = decodeURIComponent(parsed.pathname); return { scheme: parsed.protocol.slice(0, -1), path: filePath, fsPath: filePath, toString: () => value }; };",
      "Module._load = function(request, ...args) { if (request === 'vscode') return { Uri: { parse: uri } }; return originalLoad.call(this, request, ...args); };",
      "const { ResourceUniverseNavigationFacade } = require(process.argv[1]);",
      "const localLayer = { layerId: 'local', role: 'local', source: 'directory', rootUri: 'file:///pack', priority: 0, metadataRevision: 'm1' };",
      "const context = { projectId: 'project', workspaceFolderUri: 'file:///pack', projectRootUri: 'file:///pack', packRootUri: 'file:///pack', assetsRootUri: 'file:///pack/assets', rsglSourceRootUris: ['file:///pack/rsgl'], outputPackRootUri: 'file:///pack', outputAssetsRootUri: 'file:///pack/assets', localLayer, externalLayers: [], overlaySelection: [], configurationRevision: 'c1', contextRevision: 'r1' };",
      "const projects = { resolveProject: async () => ({ context, rsglApplicability: 'conventional' }), getRsglApplicability: () => 'conventional', findCachedContextsForUri: () => [], getCachedContexts: () => [] };",
      "let refreshed = false; let physicalRefreshes = 0; let exactCalls = 0; let indexResolutions = 0; let exactMode = 'resolved';",
      "const coverage = { status: 'authoritative', revision: 'physical-r1', coveredScope: { projectId: 'project' } };",
      "const index = { getCoverage: () => refreshed ? coverage : undefined, resolve: target => { indexResolutions++; return { status: 'missing', target, coverageComplete: true, candidates: [], unavailableProviderIds: [] }; } };",
      "const universe = { index, getCoverage: () => refreshed ? coverage : undefined, refreshProviderProject: async () => { physicalRefreshes++; refreshed = true; return { applied: true }; }, invalidateProviderProject: () => undefined, onDidChange: () => ({ dispose() {} }), getProducersForKey: () => [], getProjectProducers: () => [], hasProvider: () => true, getRegisteredProvider: () => ({}) };",
      "const exact = { resolveExactDefinition: async request => { exactCalls++; assert.strictEqual(request.scope, 'local'); if (exactMode === 'resolved') return { status: 'resolved', target: request.target, definition: { uri: 'file:///pack/assets/demo/models/block/target.json', outputPath: 'assets/demo/models/block/target.json', assetsRootUri: 'file:///pack/assets', layer: localLayer } }; if (exactMode === 'missing') return { status: 'missing', target: request.target, outputPath: 'assets/demo/models/block/target.json' }; if (exactMode === 'throw') throw new Error('exact probe failed'); return { status: 'fallback', target: request.target, reason: 'unsupportedLayer' }; } };",
      "const facade = new ResourceUniverseNavigationFacade(projects, universe, () => null); facade.setPhysicalDefinitionResolver(exact);",
      "const source = uri('file:///pack/rsgl/main.rsgl'); const target = { kind: 'model', id: 'demo:block/target' };",
      "(async () => {",
      "  let result = await facade.resolveLogicalDefinition(source, target, 'local');",
      "  assert.deepStrictEqual(result.directLocations, [{ uri: 'file:///pack/assets/demo/models/block/target.json', origin: 'physical' }]);",
      "  exactMode = 'missing'; result = await facade.resolveLogicalDefinition(source, target, 'local');",
      "  assert.deepStrictEqual(result.directLocations, []);",
      "  exactMode = 'throw'; result = await facade.resolveLogicalDefinition(source, target, 'local');",
      "  assert.strictEqual(result.navigation.status, 'missing');",
      "  refreshed = false; exactMode = 'fallback'; result = await facade.resolveLogicalDefinition(source, target, 'local');",
      "  assert.strictEqual(result.navigation.status, 'missing');",
      "  exactMode = 'must-not-run'; result = await facade.resolveLogicalDefinition(source, target, 'local');",
      "  assert.strictEqual(result.navigation.status, 'missing');",
      "  assert.deepStrictEqual({ exactCalls, physicalRefreshes, indexResolutions }, { exactCalls: 4, physicalRefreshes: 2, indexResolutions: 3 });",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");
    const result = runFacadeScript(script);
    assert.strictEqual(result.status, 0, String(result.stderr));
  });

  it("fully refreshes References and filters incoming edges to the current project", () => {
    const script = [
      "const assert = require('node:assert');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const uri = value => { const parsed = new URL(value); const filePath = decodeURIComponent(parsed.pathname); return { scheme: parsed.protocol.slice(0, -1), path: filePath, fsPath: filePath, toString: () => value }; };",
      "Module._load = function(request, ...args) { if (request === 'vscode') return { Uri: { parse: uri } }; return originalLoad.call(this, request, ...args); };",
      "const { ResourceUniverseNavigationFacade } = require(process.argv[1]);",
      "const localLayer = { layerId: 'local-a', role: 'local', source: 'directory', rootUri: 'file:///pack-a', priority: 0, metadataRevision: 'm1' };",
      "const context = { projectId: 'project-a', workspaceFolderUri: 'file:///pack-a', projectRootUri: 'file:///pack-a', packRootUri: 'file:///pack-a', assetsRootUri: 'file:///pack-a/assets', rsglSourceRootUris: [], outputPackRootUri: 'file:///pack-a', outputAssetsRootUri: 'file:///pack-a/assets', localLayer, externalLayers: [], overlaySelection: [], configurationRevision: 'c1', contextRevision: 'r1' };",
      "const projects = { resolveProject: async () => ({ context, rsglApplicability: 'none' }), getRsglApplicability: () => 'none', findCachedContextsForUri: () => [], getCachedContexts: () => [] };",
      "let physicalRefreshes = 0; let generatedRefreshes = 0; let refreshed = false;",
      "const target = { kind: 'model', id: 'demo:block/target' };",
      "const edge = (projectId, name) => ({ projectId, providerId: 'physical', sourceProducerId: 'producer-' + name, target, relationship: 'reference', sourceLocation: { uri: 'file:///pack-' + name + '/assets/demo/models/block/' + name + '.json', origin: 'physical', range: { start: 1, end: 2 } }, sourceReference: { kind: 'model', value: target.id, target: 'models', source: 'assets', extension: 'json' } });",
      "const coverage = { status: 'authoritative', revision: 'physical-r1', coveredScope: { projectId: 'project-a' } };",
      "const index = { getCoverage: provider => provider === 'physical' && refreshed ? coverage : undefined };",
      "const universe = { index, getCoverage: (provider, projectId) => index.getCoverage(provider, projectId), getProducersForKey: () => [], getProjectProducers: () => [], hasProvider: () => true, getRegisteredProvider: () => ({}), refreshProviderProject: async () => { physicalRefreshes++; refreshed = true; return { applied: true }; }, invalidateProviderProject: () => undefined, onDidChange: () => ({ dispose() {} }), getIncoming: () => [edge('project-a', 'a'), edge('project-b', 'b')], getProducer: () => undefined };",
      "const facade = new ResourceUniverseNavigationFacade(projects, universe, () => null);",
      "facade.setGeneratedProjectRefresher(async () => { generatedRefreshes++; });",
      "(async () => {",
      "  const result = await facade.getIncomingReferences(uri('file:///pack-a/assets/demo/models/block/target.json'), undefined, { includeGenerated: true });",
      "  assert.strictEqual(physicalRefreshes, 1, 'References remains an explicit index query'); assert.strictEqual(generatedRefreshes, 0);",
      "  assert.strictEqual(result.references.length, 1); assert.strictEqual(result.references[0].sourceUri.toString(), 'file:///pack-a/assets/demo/models/block/a.json');",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");
    const result = runFacadeScript(script);
    assert.strictEqual(result.status, 0, String(result.stderr));
  });

  it("does not invalidate newer physical work after an aborted reference refresh", () => {
    const script = [
      "const assert = require('node:assert');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const uri = value => { const parsed = new URL(value); const filePath = decodeURIComponent(parsed.pathname); return { scheme: parsed.protocol.slice(0, -1), path: filePath, fsPath: filePath, toString: () => value }; };",
      "Module._load = function(request, ...args) { if (request === 'vscode') return { Uri: { parse: uri } }; return originalLoad.call(this, request, ...args); };",
      "const { ResourceUniverseNavigationFacade } = require(process.argv[1]);",
      "const localLayer = { layerId: 'local', role: 'local', source: 'directory', rootUri: 'file:///pack', priority: 0, metadataRevision: 'm1' };",
      "const context = { projectId: 'project', workspaceFolderUri: 'file:///pack', projectRootUri: 'file:///pack', packRootUri: 'file:///pack', assetsRootUri: 'file:///pack/assets', rsglSourceRootUris: ['file:///pack/rsgl'], outputPackRootUri: 'file:///pack', outputAssetsRootUri: 'file:///pack/assets', localLayer, externalLayers: [], overlaySelection: [], configurationRevision: 'c1', contextRevision: 'r1' };",
      "const projects = { resolveProject: async () => ({ context, rsglApplicability: 'conventional' }), getRsglApplicability: () => 'conventional', findCachedContextsForUri: () => [], getCachedContexts: () => [] };",
      "let physicalRefreshes = 0; let invalidations = 0;",
      "const index = { getCoverage: () => undefined, resolve: () => ({ status: 'missing', coverageComplete: false }), getProducersForKey: () => [] };",
      "const universe = { index, getCoverage: (provider, projectId) => index.getCoverage(provider, projectId), getProducersForKey: target => index.getProducersForKey(target), getProjectProducers: () => [], hasProvider: () => true, getRegisteredProvider: () => ({}), refreshProviderProject: async (provider, projectId, scope) => { assert.strictEqual(provider, 'physical'); assert.strictEqual(projectId, 'project'); assert.deepStrictEqual(scope, { projectId: 'project' }, 'physical full-project work must use the canonical scope'); physicalRefreshes++; const error = new Error('superseded physical refresh'); error.name = 'AbortError'; throw error; }, invalidateProviderProject: () => { invalidations++; }, onDidChange: () => ({ dispose() {} }) };",
      "const facade = new ResourceUniverseNavigationFacade(projects, universe, () => null);",
      "const document = { uri: uri('file:///pack/assets/demo/models/block/consumer.json'), fileName: '/pack/assets/demo/models/block/consumer.json', languageId: 'json', getText: () => '{}' };",
      "const reference = { value: 'demo:block/target', valueNode: {}, target: 'models', source: 'assets', extension: 'json', kind: 'model' };",
      "(async () => {",
      "  const result = await facade.resolveReference(document, reference, { includeGenerated: false });",
      "  assert.strictEqual(physicalRefreshes, 1);",
      "  assert.strictEqual(invalidations, 0, 'an expected cancellation must not invalidate a newer physical generation');",
      "  assert.strictEqual(result.coverage, 'unavailable');",
      "  assert.strictEqual(result.targetUri, null);",
      "  assert.strictEqual(result.navigation.status, 'missing');",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");
    const result = runFacadeScript(script);
    assert.strictEqual(result.status, 0, String(result.stderr));
  });
});

function runFacadeScript(script: string): ReturnType<typeof spawnSync> {
  const facadePath = path.join(
    process.cwd(),
    "out",
    "src",
    "services",
    "resourceUniverseNavigationFacade.js"
  );
  return spawnSync(process.execPath, ["-e", script, facadePath], { encoding: "utf8" });
}
