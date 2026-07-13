import * as assert from "node:assert";
import {
  blockstateRootModeEvidence,
  preflightBlockstateRootOperand
} from "../../src/compiler/blockstateModePolicy";

describe("RSGL blockstate root mode policy", () => {
  it("classifies complete root operands without inspecting nested fields", () => {
    assert.strictEqual(blockstateRootModeEvidence({ custom: true }), "none");
    assert.strictEqual(blockstateRootModeEvidence({ variants: {} }), "variants");
    assert.strictEqual(blockstateRootModeEvidence({ multipart: [] }), "multipart");
    assert.strictEqual(blockstateRootModeEvidence({ variants: {}, multipart: [] }), "both");
    assert.strictEqual(blockstateRootModeEvidence({ custom: { multipart: [] } }), "none");
  });

  it("accepts mode-neutral and same-mode root operands", () => {
    assert.deepStrictEqual(
      preflightBlockstateRootOperand("variants", { custom: { enabled: true } }),
      { compatible: true, evidence: "none" }
    );
    assert.deepStrictEqual(
      preflightBlockstateRootOperand("variants", { variants: { "": {} } }),
      { compatible: true, evidence: "variants" }
    );
    assert.deepStrictEqual(
      preflightBlockstateRootOperand("multipart", { multipart: [] }),
      { compatible: true, evidence: "multipart" }
    );
  });

  it("rejects opposite and dual-mode evidence with the dedicated diagnostic", () => {
    const opposite = preflightBlockstateRootOperand("variants", { multipart: [] });
    const both = preflightBlockstateRootOperand("multipart", {
      variants: {},
      multipart: []
    });

    assert.strictEqual(opposite.compatible, false);
    assert.strictEqual(both.compatible, false);
    if (!opposite.compatible && !both.compatible) {
      assert.strictEqual(opposite.evidence, "multipart");
      assert.strictEqual(both.evidence, "both");
      assert.strictEqual(opposite.diagnostic.code, "rsgl.blockstateModeConflict");
      assert.strictEqual(both.diagnostic.code, "rsgl.blockstateModeConflict");
    }
  });
});
