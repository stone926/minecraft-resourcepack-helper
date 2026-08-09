import { resolveFreshCompiledModule } from "../../../test/helpers/compiledHarness";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../../../test/helpers/testProcess";

describe("known resource rebinding", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("uses the current producer snapshot, retains last-known facts, and clears removal", () => {
    const modulePath = resolveFreshCompiledModule("src/services/resourceUniverseNavigationFacade.ts");
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "const modulePath = process.argv[1];",
      "Module._load = function(request, ...args) {",
      "  return request === 'vscode' ? { Uri: { parse: value => ({ toString: () => value }) } }",
      "    : originalLoad.call(this, request, ...args);",
      "};",
      "const { ResourceUniverseNavigationFacade } = require(modulePath);",
      "const target = { kind: 'model', id: 'demo:block/stone' };",
      "const producer = revision => ({",
      "  producerId: 'physical:model:demo:block/stone', providerId: 'physical',",
      "  projectId: 'project', layerId: 'local', layerRole: 'local', origin: 'physical',",
      "  logicalKeys: [target],",
      "  sourceOrigins: [],",
      "  physicalOrigins: [{ uri: 'file:///pack/assets/demo/models/block/stone.json', origin: 'physical' }],",
      "  materializationState: 'handwritten', revision",
      "});",
      "let current = producer('r1'); let mode = 'resolved';",
      "const context = {",
      "  projectId: 'project', contextRevision: 'context-r1',",
      "  localLayer: { layerId: 'local' }, externalLayers: []",
      "};",
      "const projects = {",
      "  getCachedContext: projectId => projectId === 'project' ? context : undefined,",
      "  getRsglApplicability: () => 'none',",
      "  findCachedContextsForUri: () => [], getCachedContexts: () => []",
      "};",
      "const index = { resolve: () => {",
      "  if (!current || mode === 'missing') {",
      "    return { status: 'missing', target, candidates: [], coverageComplete: true, unavailableProviderIds: [] };",
      "  }",
      "  const candidate = { producer: current, matchedAs: 'concrete', layerPriority: 0 };",
      "  return mode === 'incomplete'",
      "    ? { status: 'incomplete', target, candidates: [candidate], coverageComplete: false, unavailableProviderIds: ['physical'] }",
      "    : { status: 'resolved', target, winner: current, candidates: [candidate], coverageComplete: true, unavailableProviderIds: [] };",
      "} };",
      "const universe = { index, getProducer: id => current?.producerId === id ? current : undefined };",
      "const facade = new ResourceUniverseNavigationFacade(projects, universe, () => null);",
      "const first = facade.getKnownResource(current.producerId, target);",
      "assert.strictEqual(first.producer, current); assert.strictEqual(first.resolutionStatus, 'resolved');",
      "current = producer('r2');",
      "const replaced = facade.getKnownResource(current.producerId, target);",
      "assert.strictEqual(replaced.producer, current); assert.strictEqual(replaced.producer.revision, 'r2');",
      "mode = 'incomplete';",
      "const retained = facade.getKnownResource(current.producerId, target);",
      "assert.strictEqual(retained.producer, current); assert.strictEqual(retained.resolutionStatus, 'resolved');",
      "current = undefined; mode = 'missing';",
      "assert.strictEqual(facade.getKnownResource('physical:model:demo:block/stone', target), undefined);"
    ].join("\n");

    const result = runTestProcessSync(process.execPath, ["-e", script, modulePath]);

    assertTestProcessStatus(result);
  });
});
