import * as assert from "node:assert/strict";
import {
  ResourceContributionRegistry,
  type ResourceContributionProvider
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

  it("lists providers in stable id order and resolves lookups by id", () => {
    const registry = new ResourceContributionRegistry();
    const physical = testProvider("physical");
    const rsgl = testProvider("rsgl");
    registry.register(rsgl);
    registry.register(physical);

    assert.deepStrictEqual(registry.list().map(item => item.providerId), ["physical", "rsgl"]);
    assert.strictEqual(registry.get("rsgl"), rsgl);
    assert.strictEqual(registry.get("missing"), undefined);
  });

  function testProvider(providerId: string): ResourceContributionProvider {
    return {
      providerId,
      getSnapshot: async request => ({
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
      })
    };
  }
});
