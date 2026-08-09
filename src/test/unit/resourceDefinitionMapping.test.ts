import * as assert from "node:assert/strict";
import { definitionLocationsForNavigation } from "../../providers/resourceDefinitionMapping";
import type {
  ResourceLocation,
  ResourceNavigationResult,
  ResourceProducer
} from "../../resourceUniverse";

describe("resource definition mapping", () => {
  it("uses a physical fallback only when navigation has no locations", () => {
    assert.deepStrictEqual(definitionLocationsForNavigation(undefined), []);
    assert.deepStrictEqual(definitionLocationsForNavigation(undefined, "file:///fallback.json"), [{
      uri: "file:///fallback.json",
      origin: "physical"
    }]);

    const navigation: ResourceNavigationResult = {
      status: "missing",
      target: { kind: "model", id: "example:block/machine" },
      reason: "noProducer",
      candidates: []
    };
    assert.deepStrictEqual(definitionLocationsForNavigation(navigation, "file:///fallback.json"), [{
      uri: "file:///fallback.json",
      origin: "physical"
    }]);
  });

  it("preserves resolved primary/alternative order and removes duplicate offsets", () => {
    const primary = location("file:///primary.rsgl", "generated", 5, 9);
    const alternative = location("file:///materialized.json", "materialized", 1, 3);
    const producer = createProducer("producer", [primary], [alternative]);
    const navigation: ResourceNavigationResult = {
      status: "resolved",
      target: { kind: "model", id: "example:block/machine" },
      primary,
      alternatives: [alternative, { ...alternative }],
      producer,
      resolutionIncomplete: false
    };

    assert.deepStrictEqual(definitionLocationsForNavigation(navigation, "file:///unused.json"), [
      primary,
      alternative
    ]);
  });

  it("flattens multiple candidates in candidate, source-origin, then physical-origin order", () => {
    const firstSource = location("file:///first.rsgl", "generated", 10, 15);
    const shared = location("file:///shared.json", "physical");
    const secondSource = location("file:///second.rsgl", "generated", 20, 25);
    const secondPhysical = location("file:///second.json", "materialized");
    const navigation: ResourceNavigationResult = {
      status: "multiple",
      target: { kind: "model", id: "example:block/machine" },
      candidates: [
        createProducer("first", [firstSource], [shared]),
        createProducer("second", [shared, secondSource], [secondPhysical])
      ],
      resolutionIncomplete: true
    };

    assert.deepStrictEqual(definitionLocationsForNavigation(navigation), [
      firstSource,
      shared,
      secondSource,
      secondPhysical
    ]);
  });
});

function location(
  uri: string,
  origin: ResourceLocation["origin"],
  start?: number,
  end?: number
): ResourceLocation {
  return {
    uri,
    origin,
    ...(start === undefined || end === undefined ? {} : { range: { start, end } })
  };
}

function createProducer(
  producerId: string,
  sourceOrigins: readonly ResourceLocation[],
  physicalOrigins: readonly ResourceLocation[]
): ResourceProducer {
  return {
    producerId,
    providerId: "test-provider",
    projectId: "test-project",
    layerId: "test-layer",
    layerRole: "local",
    origin: "generated",
    logicalKeys: [{ kind: "model", id: "example:block/machine" }],
    sourceOrigins,
    physicalOrigins,
    materializationState: "current",
    revision: "1"
  };
}
