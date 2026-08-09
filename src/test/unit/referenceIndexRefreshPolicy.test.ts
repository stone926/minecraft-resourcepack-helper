import * as assert from "node:assert/strict";
import {
  requiresReferenceIndexRefresh,
  type LegacyReferenceEvidence
} from "../../services/referenceIndexRefreshPolicy";

describe("reference index refresh policy", () => {
  for (const legacyEvidence of ["localWinner", "otherWinner", "miss"] as const) {
    it(`trusts ${legacyEvidence} when every physical layer is a directory`, () => {
      assert.strictEqual(requiresRefresh({ legacyEvidence }), false);
    });
  }

  it("trusts a local winner even when a lower archive layer exists", () => {
    assert.strictEqual(requiresRefresh({
      legacyEvidence: "localWinner",
      layerSources: ["directory", "zip"]
    }), false);
  });

  it("requires the Universe for a legacy miss when an archive layer exists", () => {
    for (const archive of ["zip", "clientJar", "assetIndex"] as const) {
      assert.strictEqual(requiresRefresh({
        legacyEvidence: "miss",
        layerSources: ["directory", archive]
      }), true, archive);
    }
  });

  it("stays conservative for a non-local winner when an archive layer exists", () => {
    assert.strictEqual(requiresRefresh({
      legacyEvidence: "otherWinner",
      layerSources: ["directory", "zip"]
    }), true);
  });

  it("stays conservative when the legacy resolver fails", () => {
    assert.strictEqual(requiresRefresh({ legacyEvidence: "unavailable" }), true);
  });

  it("requires the Universe for non-file documents", () => {
    assert.strictEqual(requiresRefresh({
      documentScheme: "vscode-remote",
      legacyEvidence: "localWinner"
    }), true);
  });

  it("requires the Universe unless non-RSGL applicability is explicit", () => {
    for (const rsglApplicability of [undefined, "configured", "conventional"] as const) {
      assert.strictEqual(requiresRefresh({
        rsglApplicability,
        legacyEvidence: "localWinner"
      }), true, String(rsglApplicability));
    }
  });
});

function requiresRefresh(overrides: {
  documentScheme?: string;
  rsglApplicability?: "configured" | "conventional" | "none";
  legacyEvidence: LegacyReferenceEvidence;
  layerSources?: readonly ("directory" | "zip" | "clientJar" | "assetIndex")[];
}): boolean {
  return requiresReferenceIndexRefresh({
    documentScheme: overrides.documentScheme ?? "file",
    rsglApplicability: Object.prototype.hasOwnProperty.call(overrides, "rsglApplicability")
      ? overrides.rsglApplicability
      : "none",
    legacyEvidence: overrides.legacyEvidence,
    layerSources: overrides.layerSources ?? ["directory", "directory"]
  });
}
