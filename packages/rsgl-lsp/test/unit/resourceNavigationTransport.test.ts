import * as assert from "node:assert";
import { rsglResourceNavigationProtocolVersion } from "../../../rsgl-shared/src";
import {
  createResourceNavigationRequest,
  mergeLspResourceLocations,
  requireMatchingResourceNavigationResponse,
  toLspResourceNavigationLocations
} from "../../src/resourceNavigationTransport";

describe("RSGL ResourceUniverse navigation transport", () => {
  it("builds a contentless URI request and rejects stale generations", () => {
    const request = createResourceNavigationRequest(
      "definition",
      11,
      "vscode-remote://ssh-remote+dev/work/%E8%B5%84%E6%BA%90/main.rsgl",
      {
        target: { kind: "model", id: "demo:block/base" },
        resolutionScope: "custom",
        declarationMode: "checked"
      }
    );
    assert.strictEqual(JSON.stringify(request).includes("C:\\"), false);
    assert.throws(() => requireMatchingResourceNavigationResponse({
      protocolVersion: rsglResourceNavigationProtocolVersion,
      requestGeneration: 10,
      operation: "definition",
      status: "resolved",
      coverage: "authoritative",
      locations: [{ uri: "mcres-archive://pack/assets/demo/models/block/base.json", origin: "physical" }]
    }, request), /does not match/);
  });

  it("preserves virtual URIs and supplies only the LSP-required zero range", () => {
    const locations = toLspResourceNavigationLocations({
      protocolVersion: rsglResourceNavigationProtocolVersion,
      requestGeneration: 1,
      operation: "definition",
      status: "resolved",
      coverage: "authoritative",
      locations: [{
        uri: "mcres-archive://client/assets/minecraft/textures/block/stone.png",
        origin: "physical"
      }]
    });
    assert.deepStrictEqual(locations, [{
      uri: "mcres-archive://client/assets/minecraft/textures/block/stone.png",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
      }
    }]);
  });

  it("merges physical and generated References without duplicates", () => {
    const shared = {
      uri: "file:///pack/assets/demo/models/block/consumer.json",
      range: {
        start: { line: 2, character: 13 },
        end: { line: 2, character: 28 }
      }
    };
    assert.deepStrictEqual(mergeLspResourceLocations([
      [shared],
      [shared, {
        uri: "file:///pack/rsgl/main.rsgl",
        range: {
          start: { line: 4, character: 9 },
          end: { line: 4, character: 24 }
        }
      }]
    ]), [shared, {
      uri: "file:///pack/rsgl/main.rsgl",
      range: {
        start: { line: 4, character: 9 },
        end: { line: 4, character: 24 }
      }
    }]);
  });
});
