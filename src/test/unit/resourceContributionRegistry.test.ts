import * as assert from "node:assert";
import {
  ResourceContributionRegistry,
  type ResourceContributionProvider,
  type ResourceProviderSnapshot
} from "../../resourceUniverse/core";

describe("resource contribution provider registry", () => {
  it("registers providers uniquely and disposes a registration idempotently", () => {
    const registry = new ResourceContributionRegistry();
    const provider = testProvider("physical");
    const registration = registry.register(provider);
    assert.deepStrictEqual(registry.list().map(item => item.providerId), ["physical"]);
    assert.throws(() => registry.register(provider), /already registered/);

    registration.dispose();
    registration.dispose();
    assert.deepStrictEqual(registry.list(), []);
  });

  it("requests selected providers in caller order and preserves abort signals", async () => {
    const registry = new ResourceContributionRegistry();
    const calls: string[] = [];
    registry.register(testProvider("physical", calls));
    registry.register(testProvider("rsgl", calls));
    const controller = new AbortController();
    const snapshots = await registry.requestSnapshots({
      projectId: "project",
      scope: { projectId: "project" },
      requestGeneration: 7
    }, controller.signal, ["rsgl", "physical"]);

    assert.deepStrictEqual(calls, ["rsgl:7:false", "physical:7:false"]);
    assert.deepStrictEqual(snapshots.map(snapshot => snapshot.providerId), ["rsgl", "physical"]);
    await assert.rejects(
      registry.requestSnapshots({
        projectId: "project",
        scope: { projectId: "project" },
        requestGeneration: 8
      }, controller.signal, ["missing"]),
      /Unknown resource provider/
    );
  });

  function testProvider(providerId: string, calls: string[] = []): ResourceContributionProvider {
    return {
      providerId,
      getSnapshot: async (request, signal): Promise<ResourceProviderSnapshot> => {
        calls.push(`${providerId}:${request.requestGeneration}:${signal.aborted}`);
        return {
          providerId,
          projectId: request.projectId,
          generation: request.requestGeneration,
          coverage: {
            status: "authoritative",
            revision: "r1",
            coveredScope: request.scope
          },
          producers: [],
          edges: []
        };
      }
    };
  }
});
