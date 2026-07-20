import * as assert from "node:assert";
import {
  isRsglResourceNavigationRequest,
  isRsglResourceNavigationResponse,
  rsglResourceNavigationProtocolVersion,
  type RsglResourceNavigationRequest,
  type RsglResourceNavigationResponse
} from "../../src";

describe("RSGL ResourceUniverse navigation protocol", () => {
  it("accepts URI-safe directory, archive, client-jar, and remote locations", () => {
    for (const uri of [
      "file:///C:/Workspace%20%E8%B5%84%E6%BA%90/assets/demo/models/block/a.json",
      "mcres-archive://zip-revision/assets/demo/models/block/a.json",
      "mcres-archive://client-jar-revision/assets/minecraft/models/block/cube_all.json",
      "vscode-remote://ssh-remote+dev/work/%E8%B5%84%E6%BA%90/assets/demo/models/block/a.json"
    ]) {
      const value: RsglResourceNavigationResponse = {
        ...baseResponse(),
        status: "resolved",
        coverage: "authoritative",
        locations: [{ uri, origin: "physical" }]
      };
      assert.strictEqual(isRsglResourceNavigationResponse(value), true, uri);
    }
  });

  it("rejects native paths, protocol mismatches, and stale response generations", () => {
    const request = baseRequest();
    assert.strictEqual(isRsglResourceNavigationRequest({
      ...request,
      sourceContext: { documentUri: "C:\\workspace\\main.rsgl" }
    }), false);
    assert.strictEqual(isRsglResourceNavigationRequest({
      ...request,
      protocolVersion: rsglResourceNavigationProtocolVersion + 1
    }), false);
    assert.strictEqual(isRsglResourceNavigationResponse({
      ...baseResponse(),
      locations: [{ uri: "C:\\pack\\model.json", origin: "physical" }]
    }), false);
  });

  it("requires structured reasons for unchecked and unavailable results", () => {
    assert.strictEqual(isRsglResourceNavigationResponse({
      ...baseResponse(),
      status: "unchecked",
      locations: [],
      reason: "existenceCheckDisabled"
    }), true);
    assert.strictEqual(isRsglResourceNavigationResponse({
      ...baseResponse(),
      status: "unchecked",
      locations: [],
      reason: undefined
    }), false);
    assert.strictEqual(isRsglResourceNavigationResponse({
      ...baseResponse(),
      status: "unavailable",
      locations: [{ uri: "file:///fake.json", origin: "physical" }],
      reason: "providerUnavailable"
    }), false);
  });
});

function baseRequest(): RsglResourceNavigationRequest {
  return {
    protocolVersion: rsglResourceNavigationProtocolVersion,
    requestGeneration: 7,
    operation: "definition",
    sourceContext: { documentUri: "file:///workspace/main.rsgl" },
    target: { kind: "model", id: "demo:block/base" },
    resolutionScope: "local",
    declarationMode: "checked"
  };
}

function baseResponse(): RsglResourceNavigationResponse {
  return {
    protocolVersion: rsglResourceNavigationProtocolVersion,
    requestGeneration: 7,
    operation: "definition",
    status: "missing",
    coverage: "authoritative",
    locations: [],
    reason: "noProducer"
  };
}
