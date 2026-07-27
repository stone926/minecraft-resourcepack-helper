import * as assert from "node:assert";
import type { RsglMaterializationInvalidation } from "../../packages/rsgl-core/src/compiler/materializationTypes";
import {
  parseRsglMaterializationInvalidation,
  type RsglMaterializationInvalidationDto
} from "../../packages/rsgl-shared/src";

describe("RSGL materialization invalidation protocol", () => {
  it("keeps the rsgl-core producer type and the rsgl-shared wire DTO assignable both ways", () => {
    // rsgl-core must not depend on rsgl-shared, so the shape is declared twice
    // on purpose; these compile-time assignments are the drift guard.
    const producerSample: RsglMaterializationInvalidation = {
      version: 1,
      transactionId: "txn",
      projectId: "project",
      ownershipRevision: "rev",
      state: "committed",
      changedUris: ["file:///pack/assets/a.json"],
      deletedUris: [],
      manifestUri: "file:///pack/.rsgl/manifest.json"
    };
    const asWire: RsglMaterializationInvalidationDto = producerSample;
    const asProducer: RsglMaterializationInvalidation = asWire;
    assert.strictEqual(asProducer, producerSample);
  });

  it("parses a producer-shaped payload through the shared wire guard", () => {
    const payload: RsglMaterializationInvalidation = {
      version: 1,
      transactionId: " txn ",
      projectId: "project",
      ownershipRevision: "rev",
      state: "partial",
      changedUris: [],
      deletedUris: ["file:///pack/assets/old.json"],
      manifestUri: "file:///pack/.rsgl/manifest.json"
    };
    const parsed = parseRsglMaterializationInvalidation(payload);
    assert.ok(parsed);
    assert.strictEqual(parsed.transactionId, "txn");
    assert.strictEqual(parsed.state, "partial");
    assert.deepStrictEqual(parsed.deletedUris, payload.deletedUris);
  });

  it("rejects payloads that violate the wire contract", () => {
    assert.strictEqual(parseRsglMaterializationInvalidation(null), undefined);
    assert.strictEqual(parseRsglMaterializationInvalidation({ version: 2 }), undefined);
    assert.strictEqual(parseRsglMaterializationInvalidation({
      version: 1,
      transactionId: "txn",
      projectId: "project",
      ownershipRevision: "rev",
      state: "committed",
      changedUris: ["E:\\not-a-uri.json"],
      deletedUris: [],
      manifestUri: "file:///pack/.rsgl/manifest.json"
    }), undefined);
  });
});
