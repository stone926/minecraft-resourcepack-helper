import * as assert from "node:assert";
import type { ProviderCoverage } from "../../resourceUniverse";
import {
  combineResourceFactsCoverage,
  summarizeDocumentProviderFacts,
  summarizeGeneratedInventoryFacts,
  summarizeLocalPhysicalInventoryFacts
} from "../../services/resourceFactsCoverage";

describe("resource facts coverage", () => {
  const partialCoverage = (skippedSourceUris: string[]): ProviderCoverage => ({
    status: "partial",
    revision: "r1",
    authoritativeScopes: [],
    unavailableScopes: [{ projectId: "project" }],
    skippedSourceUris
  });

  it("does not label RSGL facts partial because an unrelated layer is missing", () => {
    assert.deepStrictEqual(
      summarizeDocumentProviderFacts(
        "rsgl",
        partialCoverage(["file:///missing/custom-pack"]),
        "file:///E:/pack/rsgl/leaves.rsgl"
      ),
      { providerId: "rsgl", coverage: "authoritative" }
    );
  });

  it("matches a skipped Windows source through canonical URI identity", () => {
    assert.deepStrictEqual(
      summarizeDocumentProviderFacts(
        "rsgl",
        partialCoverage(["file:///E:/pack/rsgl/leaves.rsgl"]),
        "file:///e%3A/pack/rsgl/leaves.rsgl"
      ),
      {
        providerId: "rsgl",
        coverage: "partial",
        skippedSourceUris: ["file:///E:/pack/rsgl/leaves.rsgl"]
      }
    );
  });

  it("limits physical inventory coverage to the local pack", () => {
    const localRoot = "file:///E:/pack";
    assert.strictEqual(
      summarizeLocalPhysicalInventoryFacts(
        partialCoverage(["file:///E:/missing-custom-pack"]),
        localRoot
      ),
      "authoritative"
    );
    assert.strictEqual(
      summarizeLocalPhysicalInventoryFacts(
        partialCoverage(["file:///e%3A/pack/assets/minecraft/models/broken.json"]),
        localRoot
      ),
      "partial"
    );
  });

  it("keeps skipped RSGL sources visible in inventory coverage", () => {
    assert.strictEqual(
      summarizeGeneratedInventoryFacts(partialCoverage(["file:///pack/rsgl/broken.rsgl"])),
      "partial"
    );
    assert.strictEqual(
      summarizeGeneratedInventoryFacts({
        status: "unavailable",
        reason: "lspFailed"
      }),
      "unavailable"
    );
  });

  it("combines available and unavailable provider facts conservatively", () => {
    assert.strictEqual(combineResourceFactsCoverage([]), "authoritative");
    assert.strictEqual(
      combineResourceFactsCoverage(["authoritative", "unavailable"]),
      "partial"
    );
    assert.strictEqual(
      combineResourceFactsCoverage(["unavailable", "unavailable"]),
      "unavailable"
    );
  });
});
