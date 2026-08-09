import { resolveFreshCompiledModule } from "../../../test/helpers/compiledHarness";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../../../test/helpers/testProcess";

describe("integrated RSGL ResourceUniverse navigation bridge", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("registers the lazy generated provider before the first generated projection", () => {
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const uri = value => ({ path: new URL(value).pathname, toString: () => value });",
      "Module._load = function(request, ...args) { if (request === 'vscode') return { Uri: { parse: uri } }; return originalLoad.call(this, request, ...args); };",
      "const { ResourceUniverseNavigationFacade } = require(process.argv[1]);",
      "const context = { projectId: 'project', contextRevision: 'r1', projectRootUri: 'file:///pack', localLayer: { layerId: 'local' }, externalLayers: [] };",
      "let generatedRegistered = false; let generatedRefreshes = 0;",
      "const coverage = { status: 'authoritative', revision: 'r1', coveredScope: { projectId: 'project' } };",
      "const projects = { resolveProject: async () => ({ context, rsglApplicability: 'conventional' }), getRsglApplicability: () => 'conventional' };",
      "const universe = {",
      "  getCoverage: provider => provider === 'physical' || generatedRegistered ? coverage : undefined,",
      "  hasProvider: provider => provider === 'physical' || generatedRegistered,",
      "  getRegisteredProvider: provider => provider === 'physical' || generatedRegistered ? {} : undefined,",
      "  getProjectProducers: () => [], getProducersForKey: () => [],",
      "  index: { getCoverage: provider => provider === 'physical' || generatedRegistered ? coverage : undefined },",
      "  refreshProviderProject: async () => ({ applied: true }), invalidateProviderProject: () => undefined,",
      "  onDidChange: () => ({ dispose() {} }),",
      "  getDocumentProviderIds: document => generatedRegistered && document.languageId === 'rsgl' ? ['rsgl'] : [],",
      "  getDocumentProjections: () => generatedRegistered ? [{ resources: [] }] : []",
      "};",
      "const facade = new ResourceUniverseNavigationFacade(projects, universe, () => null);",
      "facade.setGeneratedProjectRefresher(async () => { generatedRefreshes++; generatedRegistered = true; });",
      "(async () => {",
      "  const document = { uri: uri('file:///pack/generated/source'), fileName: '/pack/rsgl/main.rsgl', languageId: 'plaintext' };",
      "  const result = await facade.getDocumentProjection(document);",
      "  assert.strictEqual(generatedRefreshes, 1); assert.strictEqual(result.applicable, true);",
      "  assert.strictEqual(result.coverage, 'authoritative'); assert.strictEqual(result.projections.length, 1);",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");
    const facadePath = resolveFreshCompiledModule("src/services/resourceUniverseNavigationFacade.ts");
    const result = runTestProcessSync(process.execPath, ["-e", script, facadePath]);
    assertTestProcessStatus(result);
  });

  it("does not probe generated facts for an explicitly non-RSGL project", () => {
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "Module._load = function(request, ...args) { if (request === 'vscode') return { Uri: { parse: value => ({ toString: () => value }) } }; return originalLoad.call(this, request, ...args); };",
      "const { ResourceUniverseNavigationFacade } = require(process.argv[1]);",
      "const context = { projectId: 'project', contextRevision: 'r1', projectRootUri: 'file:///pack', localLayer: { layerId: 'local' }, externalLayers: [] };",
      "let applicability = 'none'; let generatedRefreshes = 0; let physicalRefreshes = 0; let generatedFailure; const invalidations = [];",
      "const projects = { resolveProject: async () => ({ context, rsglApplicability: applicability }), getRsglApplicability: () => applicability };",
      "const physicalCoverage = { status: 'authoritative', revision: 'r1', coveredScope: { projectId: 'project' } };",
      "const universe = {",
      "  getCoverage: provider => provider === 'physical' ? physicalCoverage : undefined,",
      "  hasProvider: () => true, getRegisteredProvider: () => ({}),",
      "  getProjectProducers: () => [], getProducersForKey: () => [],",
      "  index: { getCoverage: provider => provider === 'physical' ? physicalCoverage : undefined },",
      "  refreshProviderProject: async provider => { if (provider === 'physical') physicalRefreshes++; return { applied: true }; },",
      "  invalidateProviderProject: (...args) => invalidations.push(args), onDidChange: () => ({ dispose() {} })",
      "};",
      "const facade = new ResourceUniverseNavigationFacade(projects, universe, () => null);",
      "facade.setGeneratedProjectRefresher(async () => { generatedRefreshes++; if (generatedFailure) throw generatedFailure; });",
      "(async () => {",
      "  await facade.ensureProjectForUri({ toString: () => 'file:///pack' }, { includeGenerated: true });",
      "  assert.strictEqual(generatedRefreshes, 0); assert.strictEqual(physicalRefreshes, 1);",
      "  applicability = undefined;",
      "  await facade.ensureProjectForUri({ toString: () => 'file:///pack' }, { includeGenerated: true });",
      "  assert.strictEqual(generatedRefreshes, 1, 'unknown applicability stays conservative');",
      "  const abort = new AbortController(); abort.abort();",
      "  await facade.ensureProjectForUri({ toString: () => 'file:///pack' }, { includeGenerated: true, signal: abort.signal });",
      "  assert.strictEqual(generatedRefreshes, 1, 'pre-cancelled queries do not load generated resources');",
      "  generatedFailure = Object.assign(new Error('shared cancellation'), { name: 'AbortError' });",
      "  await facade.ensureProjectForUri({ toString: () => 'file:///pack' }, { includeGenerated: true });",
      "  assert.strictEqual(invalidations.length, 0, 'shared AbortError must not poison generated coverage');",
      "  generatedFailure = new Error('lsp failed');",
      "  await facade.ensureProjectForUri({ toString: () => 'file:///pack' }, { includeGenerated: true });",
      "  assert.deepStrictEqual(invalidations.at(-1), ['rsgl', 'project', 'lspFailed']);",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");
    const facadePath = resolveFreshCompiledModule("src/services/resourceUniverseNavigationFacade.ts");
    const result = runTestProcessSync(process.execPath, ["-e", script, facadePath]);
    assertTestProcessStatus(result);
  });

  it("returns scoped directory/ZIP/JAR/remote definitions and physical References without fake paths", () => {
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module');",
      "const originalLoad = Module._load;",
      "const uri = value => ({ value, toString: () => value });",
      "const texts = new Map([['file:///pack/assets/demo/models/block/consumer.json', '{\\n  \\\"parent\\\": \\\"demo:block/base\\\"\\n}']]);",
      "Module._load = function(request, ...args) {",
      "  if (request === 'vscode') return {",
      "    Uri: { parse: value => uri(value) },",
      "    workspace: { openTextDocument: async target => {",
      "      const text = texts.get(target.toString()) || '';",
      "      return { getText: () => text, positionAt: offset => {",
      "        const before = text.slice(0, Math.max(0, Math.min(text.length, offset)));",
      "        const lines = before.split('\\n'); return { line: lines.length - 1, character: lines.at(-1).length };",
      "      } };",
      "    } }",
      "  };",
      "  return originalLoad.call(this, request, ...args);",
      "};",
      "const { resolveRsglResourceNavigation } = require(process.argv[1]);",
      "const protocol = require(process.argv[2]);",
      "const seen = [];",
      "const locationById = {",
      "  'demo:block/local': 'file:///C:/Pack%20%E8%B5%84%E6%BA%90/assets/demo/models/block/local.json',",
      "  'demo:block/zip': 'mcres-archive://zip-r1/assets/demo/models/block/zip.json',",
      "  'minecraft:block/cube_all': 'mcres-archive://client-jar-r1/assets/minecraft/models/block/cube_all.json',",
      "  'demo:block/remote': 'vscode-remote://ssh-remote+dev/work/%E8%B5%84%E6%BA%90/assets/demo/models/block/remote.json'",
      "};",
      "const facade = {",
      "  resolveLogicalDefinition: async (source, target, scope) => {",
      "    seen.push(['definition', source.toString(), target.id, scope]);",
      "    if (target.id === 'demo:block/direct') return { context: { projectId: 'project' }, coverage: 'authoritative', directLocations: [{ uri: 'file:///pack/assets/demo/models/block/direct.json', origin: 'physical' }] };",
      "    if (target.id === 'demo:block/direct_missing') return { context: { projectId: 'project' }, coverage: 'authoritative', directLocations: [] };",
      "    if (target.id === 'demo:block/missing') return { context: { projectId: 'project' }, coverage: 'partial', navigation: { status: 'incomplete', target, reason: 'providerUnavailable', candidates: [] } };",
      "    const targetUri = locationById[target.id];",
      "    return { context: { projectId: 'project' }, coverage: 'authoritative', navigation: {",
      "      status: 'resolved', target, primary: { uri: targetUri, origin: 'physical', editable: !targetUri.startsWith('mcres-archive:') }, alternatives: [],",
      "      producer: {}, resolutionIncomplete: false",
      "    } };",
      "  },",
      "  getLogicalIncomingReferenceLocations: async (source, target) => {",
      "    seen.push(['references', source.toString(), target.id]);",
      "    return { context: { projectId: 'project' }, coverage: 'authoritative', locations: [{",
      "      uri: 'file:///pack/assets/demo/models/block/consumer.json', origin: 'physical', range: { start: 16, end: 31 }",
      "    }] };",
      "  }",
      "};",
      "let generation = 0;",
      "const request = (operation, id, scope, mode = 'checked', extra = {}) => ({",
      "  protocolVersion: protocol.rsglResourceNavigationProtocolVersion, requestGeneration: ++generation, operation,",
      "  sourceContext: { documentUri: extra.documentUri || 'file:///pack/rsgl/main.rsgl' },",
      "  target: { kind: 'model', id }, resolutionScope: scope, declarationMode: mode,",
      "  ...(operation === 'references' ? { includeDeclaration: extra.includeDeclaration === true } : {})",
      "});",
      "(async () => {",
      "  for (const [id, scope] of [['demo:block/local','local'], ['demo:block/zip','custom'], ['minecraft:block/cube_all','vanilla']]) {",
      "    const result = await resolveRsglResourceNavigation(facade, request('definition', id, scope), new AbortController().signal);",
      "    assert.strictEqual(result.status, 'resolved'); assert.strictEqual(result.locations[0].uri, locationById[id]);",
      "  }",
      "  const remoteSource = 'vscode-remote://ssh-remote+dev/work/%E8%B5%84%E6%BA%90/rsgl/main.rsgl';",
      "  const remote = await resolveRsglResourceNavigation(facade, request('definition','demo:block/remote','local','checked',{documentUri:remoteSource}), new AbortController().signal);",
      "  assert.strictEqual(remote.locations[0].uri, locationById['demo:block/remote']); assert.ok(seen.some(row => row[1] === remoteSource));",
      "  const unchecked = await resolveRsglResourceNavigation(facade, request('definition','minecraft:block/cube_all','vanilla','unchecked'), new AbortController().signal);",
      "  assert.deepStrictEqual({status:unchecked.status, reason:unchecked.reason, count:unchecked.locations.length}, {status:'unchecked', reason:'existenceCheckDisabled', count:0});",
      "  const missing = await resolveRsglResourceNavigation(facade, request('definition','demo:block/missing','custom'), new AbortController().signal);",
      "  assert.deepStrictEqual({status:missing.status, reason:missing.reason, coverage:missing.coverage}, {status:'incomplete', reason:'providerUnavailable', coverage:'partial'});",
      "  const direct = await resolveRsglResourceNavigation(facade, request('definition','demo:block/direct','local'), new AbortController().signal);",
      "  assert.deepStrictEqual({status:direct.status, uri:direct.locations[0].uri}, {status:'resolved', uri:'file:///pack/assets/demo/models/block/direct.json'});",
      "  const directMissing = await resolveRsglResourceNavigation(facade, request('definition','demo:block/direct_missing','local'), new AbortController().signal);",
      "  assert.deepStrictEqual({status:directMissing.status, reason:directMissing.reason, count:directMissing.locations.length}, {status:'missing', reason:'noProducer', count:0});",
      "  const refs = await resolveRsglResourceNavigation(facade, request('references','demo:block/local','local','checked',{includeDeclaration:true}), new AbortController().signal);",
      "  assert.strictEqual(refs.status, 'resolved'); assert.deepStrictEqual(refs.locations.map(item => item.uri).sort(), [locationById['demo:block/local'], 'file:///pack/assets/demo/models/block/consumer.json'].sort());",
      "  assert.deepStrictEqual(refs.locations.find(item => item.range).range, { start: { line: 1, character: 14 }, end: { line: 1, character: 29 } });",
      "  const directRefs = await resolveRsglResourceNavigation(facade, request('references','demo:block/direct','local','checked',{includeDeclaration:true}), new AbortController().signal);",
      "  assert.deepStrictEqual(directRefs.locations.map(item => item.uri).sort(), ['file:///pack/assets/demo/models/block/direct.json', 'file:///pack/assets/demo/models/block/consumer.json'].sort());",
      "  const abort = new AbortController(); abort.abort();",
      "  const cancelled = await resolveRsglResourceNavigation(facade, request('definition','demo:block/local','local'), abort.signal);",
      "  assert.strictEqual(cancelled.status, 'cancelled');",
      "  const postAwaitAbort = new AbortController();",
      "  const cancellingFacade = { ...facade, resolveLogicalDefinition: async () => { postAwaitAbort.abort(); return { context: { projectId: 'project' }, coverage: 'authoritative', directLocations: [{ uri: 'file:///pack/assets/demo/models/block/direct.json', origin: 'physical' }] }; } };",
      "  const cancelledAfterResolution = await resolveRsglResourceNavigation(cancellingFacade, request('definition','demo:block/direct','local'), postAwaitAbort.signal);",
      "  assert.strictEqual(cancelledAfterResolution.status, 'cancelled');",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");
    const bridgePath = resolveFreshCompiledModule("src/rsgl/rsglResourceNavigationBridge.ts");
    const protocolPath = resolveFreshCompiledModule("packages/rsgl-shared/src/index.ts");
    const result = runTestProcessSync(process.execPath, ["-e", script, bridgePath, protocolPath]);
    assertTestProcessStatus(result);
  });
});
