import { resolveFreshCompiledModule } from "../../../test/helpers/compiledHarness";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../../../test/helpers/testProcess";

describe("project refresh coordinator", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("retries one stale physical generation without retrying cancellation or provider coverage", () => {
    const modulePath = resolveFreshCompiledModule("src/services/projectRefreshCoordinator.ts");
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "Module._load = function(request, ...args) { return request === 'vscode' ? {} : originalLoad.call(this, request, ...args); };",
      "const { ProjectRefreshCoordinator } = require(process.argv[1]);",
      "const context = { projectId: 'project', contextRevision: 'context-r1' };",
      "const discovered = { context, rsglApplicability: 'none' };",
      "const projects = { getCachedContext: () => context, getRsglApplicability: () => 'none' };",
      "const unavailable = { status: 'unavailable', reason: 'stale' };",
      "const authoritative = { status: 'authoritative', revision: 'physical-r1', coveredScope: { projectId: 'project' } };",
      "const partial = { status: 'partial', revision: 'physical-r2', authoritativeScopes: [], unavailableScopes: [{ projectId: 'project' }], skippedSourceUris: ['file:///pack/assets/demo'] };",
      "const createUniverse = refresh => { let coverage = unavailable; return {",
      "  getCoverage: () => coverage,",
      "  refreshProviderProject: (...args) => refresh({ args, get coverage() { return coverage; }, set coverage(value) { coverage = value; } }),",
      "  invalidateProviderProject() { throw new Error('unexpected provider invalidation'); }",
      "}; };",
      "(async () => {",
      "  let calls = 0;",
      "  const recoveredUniverse = createUniverse(async state => {",
      "    calls++;",
      "    if (calls === 1) return { applied: false, reason: 'staleGeneration', snapshots: [] };",
      "    state.coverage = authoritative;",
      "    return { applied: true, snapshots: [] };",
      "  });",
      "  const recovered = new ProjectRefreshCoordinator(projects, recoveredUniverse);",
      "  const recoveredResult = await recovered.refreshDiscoveredProject(discovered, { includeGenerated: false });",
      "  assert.strictEqual(calls, 2, 'one stale generation should receive exactly one stabilization retry');",
      "  assert.strictEqual(recoveredResult.coverage, 'authoritative');",
      "  assert.strictEqual(recovered.isPhysicalIndexCurrent(context), true);",
      "",
      "  calls = 0;",
      "  const churnUniverse = createUniverse(async () => { calls++; return { applied: false, reason: 'staleGeneration', snapshots: [] }; });",
      "  const churn = new ProjectRefreshCoordinator(projects, churnUniverse);",
      "  const churnResult = await churn.refreshDiscoveredProject(discovered, { includeGenerated: false });",
      "  assert.strictEqual(calls, 2, 'continuous invalidation must keep the retry bounded');",
      "  assert.strictEqual(churnResult.coverage, 'unavailable');",
      "  assert.strictEqual(churn.isPhysicalIndexCurrent(context), false);",
      "",
      "  calls = 0; const cancellation = new AbortController();",
      "  const cancelledUniverse = createUniverse(async () => { calls++; cancellation.abort(); return { applied: false, reason: 'staleGeneration', snapshots: [] }; });",
      "  const cancelled = new ProjectRefreshCoordinator(projects, cancelledUniverse);",
      "  const cancelledResult = await cancelled.refreshDiscoveredProject(discovered, { includeGenerated: false, signal: cancellation.signal });",
      "  assert.strictEqual(calls, 1, 'caller cancellation must suppress the stabilization retry');",
      "  assert.strictEqual(cancelledResult.coverage, 'unavailable');",
      "",
      "  calls = 0;",
      "  const partialUniverse = createUniverse(async state => { calls++; state.coverage = partial; return { applied: true, snapshots: [] }; });",
      "  const partialCoordinator = new ProjectRefreshCoordinator(projects, partialUniverse);",
      "  const partialResult = await partialCoordinator.refreshDiscoveredProject(discovered, { includeGenerated: false });",
      "  assert.strictEqual(calls, 1, 'an applied partial I/O snapshot must not be retried');",
      "  assert.strictEqual(partialResult.coverage, 'partial');",
      "",
      "  calls = 0;",
      "  const unavailableUniverse = createUniverse(async () => { calls++; return { applied: true, snapshots: [] }; });",
      "  const unavailableCoordinator = new ProjectRefreshCoordinator(projects, unavailableUniverse);",
      "  const unavailableResult = await unavailableCoordinator.refreshDiscoveredProject(discovered, { includeGenerated: false });",
      "  assert.strictEqual(calls, 1, 'an applied unavailable provider snapshot must not be retried in the same request');",
      "  assert.strictEqual(unavailableResult.coverage, 'unavailable');",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");

    const result = runTestProcessSync(process.execPath, ["-e", script, modulePath]);

    assertTestProcessStatus(result);
  });
});
