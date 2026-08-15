import { resolveFreshCompiledModule } from "../../../test/helpers/compiledHarness";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../../../test/helpers/testProcess";

describe("resource graph effective blockstate inventory", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("skips legacy discovery for known authoritative projects and uses it only for anchors", () => {
    const graphPath = resolveFreshCompiledModule("src/services/resourceGraphService.ts");
    const inventoryPath = resolveFreshCompiledModule(
      "src/services/resourceSearchInventoryService.ts"
    );
    const snapshotPath = resolveFreshCompiledModule(
      "src/resourceUniverse/providers/physicalAssetSnapshot.ts"
    );
    const indexPath = resolveFreshCompiledModule(
      "src/resourceUniverse/core/resourceUniverseIndex.ts"
    );
    const navigationPath = resolveFreshCompiledModule(
      "src/resourceUniverse/navigation/resourceNavigationService.ts"
    );
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "class Uri {",
      "  constructor(value) { const parsed = new URL(value); this.value = value; this.scheme = parsed.protocol.slice(0, -1); this.path = decodeURIComponent(parsed.pathname); this.fsPath = this.path; }",
      "  static parse(value) { return new Uri(value); }",
      "  static file(value) { return new Uri('file:///' + String(value).replaceAll('\\\\', '/').replace(/^\\//, '')); }",
      "  toString() { return this.value; }",
      "}",
      "const vscode = { Uri, l10n: { t: value => value }, workspace: { textDocuments: [] }, window: {}, commands: {} };",
      "Module._load = function(request, ...args) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args); };",
      "const { ResourceGraphService } = require(process.argv[1]);",
      "const { ResourceSearchInventoryService } = require(process.argv[2]);",
      "const { createPhysicalAssetSnapshot } = require(process.argv[3]);",
      "const { ResourceUniverseIndex } = require(process.argv[4]);",
      "const { ResourceNavigationService } = require(process.argv[5]);",
      "const layer = (layerId, role, rootUri, priority) => ({ layerId, role, source: 'directory', rootUri, priority, metadataRevision: layerId + '-r1' });",
      "const local = layer('local', 'local', 'file:///pack', 0);",
      "const customHigh = layer('custom-high', 'custom', 'file:///custom-high', 10);",
      "const customLow = layer('custom-low', 'custom', 'file:///custom-low', 20);",
      "const vanilla = layer('vanilla', 'vanilla', 'file:///vanilla', 30);",
      "const context = { projectId: 'project', workspaceFolderUri: 'file:///workspace', projectRootUri: 'file:///pack', packRootUri: 'file:///pack', assetsRootUri: 'file:///pack/assets', rsglSourceRootUris: ['file:///pack/rsgl'], outputPackRootUri: 'file:///pack', outputAssetsRootUri: 'file:///pack/assets', localLayer: local, externalLayers: [customHigh, customLow], vanillaLayer: vanilla, overlaySelection: [], configurationRevision: 'c1', contextRevision: 'r1' };",
      "const physical = (name, layerValue, uri) => ({ producerId: 'physical:' + layerValue.layerId + ':' + name, providerId: 'physical', projectId: 'project', layerId: layerValue.layerId, layerRole: layerValue.role, origin: 'physical', logicalKeys: [{ kind: 'blockstate', id: 'demo:' + name }], sourceOrigins: [], physicalOrigins: [{ uri, origin: 'physical' }], materializationState: 'handwritten', outputPath: 'assets/demo/blockstates/' + name + '.json', revision: 'r1' });",
      "const generated = { producerId: 'rsgl:generated', providerId: 'rsgl', projectId: 'project', layerId: 'local', layerRole: 'local', origin: 'generated', logicalKeys: [{ kind: 'blockstate', id: 'demo:generated' }], sourceOrigins: [{ uri: 'file:///pack/rsgl/main.rsgl', origin: 'generated' }], physicalOrigins: [], materializationState: 'unbuilt', outputPath: 'assets/demo/blockstates/generated.json', revision: 'r1' };",
      "const highWinner = physical('stone', customHigh, 'file:///custom-high/assets/demo/blockstates/stone.json');",
      "const lowShadowed = physical('stone', customLow, 'file:///custom-low/assets/demo/blockstates/stone.json');",
      "const vanillaShadowed = physical('stone', vanilla, 'file:///vanilla/assets/demo/blockstates/stone.json');",
      "let contexts = [context]; let inventoryCalls = 0; let graphEnsures = 0; let refreshEnsures = 0; const requestedScopes = [];",
      "const projects = { getCachedContexts: () => contexts, getCachedContext: id => contexts.find(item => item.projectId === id) };",
      "const coverage = providerId => ({ status: 'authoritative', revision: providerId + '-r1', coveredScope: { projectId: 'project' } });",
      "const universe = { getCoverage: providerId => coverage(providerId), getProjectProducers: () => [highWinner, lowShadowed, vanillaShadowed, generated], getProducer: () => undefined };",
      "const definitionNavigation = { resolveDefinition: (target, resolutionContext) => { requestedScopes.push([...resolutionContext.orderedLayerIds]); return { status: 'resolved', producer: target.id === 'demo:stone' ? highWinner : generated, alternatives: [], coverageComplete: true }; } };",
      "const refreshCoordinator = { ensureProjectForUri: async () => { refreshEnsures++; return { rsglApplicability: 'conventional' }; }, applicableProviderIds: () => ['physical', 'rsgl'] };",
      "const inventoryService = new ResourceSearchInventoryService(projects, universe, definitionNavigation, refreshCoordinator);",
      "const navigation = { getKnownResources: async (kinds, options) => { inventoryCalls++; assert.deepStrictEqual(options, { layerScope: 'effective' }); return inventoryService.getKnownResources(kinds, options); }, ensureProjectForUri: async uri => { graphEnsures++; assert.strictEqual(uri.toString(), 'file:///pack/assets/demo/blockstates/anchor.json'); contexts = [context]; return { context, coverage: 'authoritative' }; } };",
      "let legacyCalls = 0; const legacy = { getBlockstateUris: async () => { legacyCalls++; return [Uri.parse('file:///pack/assets/demo/blockstates/anchor.json')]; } };",
      "(async () => {",
      "  const known = await new ResourceGraphService(navigation, legacy).getBlockstateInventory();",
      "  assert.strictEqual(known.status, 'authoritative');",
      "  assert.deepStrictEqual(known.uris.map(uri => uri.toString()), ['file:///custom-high/assets/demo/blockstates/stone.json']);",
      "  assert.deepStrictEqual(known.resources.map(resource => [resource.target.id, resource.producer.origin]), [['demo:generated', 'generated']]);",
      "  assert.deepStrictEqual({ legacyCalls, graphEnsures, inventoryCalls, refreshEnsures }, { legacyCalls: 0, graphEnsures: 0, inventoryCalls: 1, refreshEnsures: 1 });",
      "  assert.ok(requestedScopes.every(ids => JSON.stringify(ids) === JSON.stringify(['local', 'custom-high', 'custom-low', 'vanilla'])));",
      "  contexts = []; inventoryCalls = 0; refreshEnsures = 0; requestedScopes.length = 0;",
      "  const discovered = await new ResourceGraphService(navigation, legacy).getBlockstateInventory();",
      "  assert.strictEqual(discovered.status, 'authoritative');",
      "  assert.deepStrictEqual(discovered.uris.map(uri => uri.toString()), ['file:///custom-high/assets/demo/blockstates/stone.json']);",
      "  assert.deepStrictEqual(discovered.resources.map(resource => resource.target.id), ['demo:generated']);",
      "  assert.deepStrictEqual({ legacyCalls, graphEnsures, inventoryCalls, refreshEnsures }, { legacyCalls: 1, graphEnsures: 1, inventoryCalls: 2, refreshEnsures: 1 });",
      "  const fallbackContext = { ...context, projectId: 'fallback-project', externalLayers: [], contextRevision: 'fallback-r1' };",
      "  const fallbackIndex = new ResourceUniverseIndex();",
      "  const ownedOutputPath = 'assets/minecraft/blockstates/acacia_door.json';",
      "  const ownedDocument = (layerValue, uri) => ({ uri, fileName: new URL(uri).pathname, outputPath: ownedOutputPath, revision: layerValue.layerId + '-r1', layerId: layerValue.layerId, layerRole: layerValue.role, references: [] });",
      "  fallbackIndex.replaceSnapshot(createPhysicalAssetSnapshot({ projectId: 'fallback-project', generation: 1, revision: 'fallback-physical-r1', ownedOutputPaths: new Set([ownedOutputPath]), documents: [ownedDocument(local, 'file:///pack/assets/minecraft/blockstates/acacia_door.json'), ownedDocument(vanilla, 'file:///vanilla/assets/minecraft/blockstates/acacia_door.json')] }));",
      "  const fallbackProjects = { getCachedContexts: () => [fallbackContext], getCachedContext: () => fallbackContext };",
      "  const fallbackRefresh = { ensureProjectForUri: async () => ({ rsglApplicability: 'none' }), applicableProviderIds: () => ['physical'] };",
      "  const fallbackInventory = new ResourceSearchInventoryService(fallbackProjects, fallbackIndex, new ResourceNavigationService(fallbackIndex), fallbackRefresh);",
      "  const fallbackGraph = new ResourceGraphService({ getKnownResources: (kinds, options) => fallbackInventory.getKnownResources(kinds, options), ensureProjectForUri: async () => { throw new Error('known project must not use legacy discovery'); } }, { getBlockstateUris: async () => { throw new Error('known project must not scan the workspace'); } });",
      "  const fallbackKnown = await fallbackGraph.getBlockstateInventory();",
      "  assert.strictEqual(fallbackKnown.status, 'authoritative');",
      "  assert.deepStrictEqual(fallbackKnown.uris.map(uri => uri.toString()), ['file:///vanilla/assets/minecraft/blockstates/acacia_door.json']);",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");

    const result = runTestProcessSync(process.execPath, [
      "-e",
      script,
      graphPath,
      inventoryPath,
      snapshotPath,
      indexPath,
      navigationPath
    ]);

    assertTestProcessStatus(result);
  });
});
