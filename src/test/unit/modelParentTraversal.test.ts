import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  maxModelParentDepth,
  ModelParentTraversal
} from "../../services/modelParentTraversal";

describe("shared model parent traversal", () => {
  it("uses one cycle and depth policy for diagnostics and preview resolution", () => {
    const traversal = new ModelParentTraversal("entry.json");
    assert.deepStrictEqual(traversal.advance("parent.json"), {
      kind: "next",
      fileName: "parent.json"
    });
    assert.deepStrictEqual(traversal.advance("entry.json"), {
      kind: "cycle",
      fileName: "entry.json"
    });

    const deepTraversal = new ModelParentTraversal("entry.json");
    for (let depth = 0; depth < maxModelParentDepth; depth++) {
      assert.strictEqual(deepTraversal.advance(`parent-${depth}.json`).kind, "next");
    }
    assert.deepStrictEqual(deepTraversal.advance("too-deep.json"), {
      kind: "depth",
      fileName: "too-deep.json",
      maxDepth: maxModelParentDepth
    });
  });

  it("is consumed by both parent-chain hosts", () => {
    const workspaceSource = fs.readFileSync(
      path.join(process.cwd(), "src", "services", "modelParentChain.ts"),
      "utf8"
    );
    const previewSource = fs.readFileSync(
      path.join(process.cwd(), "src", "modelPreview", "resolve", "ParentChainResolver.ts"),
      "utf8"
    );

    assert.match(workspaceSource, /new ModelParentTraversal\(/);
    assert.match(previewSource, /new ModelParentTraversal\(/);
    assert.strictEqual(previewSource.includes("const maxParentDepth"), false);
  });
});
