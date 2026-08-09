import * as assert from "node:assert/strict";
import { ResourceGraphReferenceIndex } from "../../utils/resourceGraphReferenceIndex";

interface TestReference {
  source: string;
  target: string;
  parent?: boolean;
  value: string;
}

describe("resource graph reference index", () => {
  it("incrementally replaces, adds, and removes one source without rebuilding other incoming targets", () => {
    const index = new ResourceGraphReferenceIndex<TestReference>(reference => ({
      sourceKey: reference.source,
      targetKey: reference.target,
      modelParent: reference.parent === true
    }));
    const stable = { source: "stable.json", target: "stone.png", value: "stable" };
    index.replaceSource("stable.json", [stable]);
    index.replaceSource("changing.json", [
      { source: "changing.json", target: "stone.png", value: "old" }
    ]);

    index.replaceSource("changing.json", [
      { source: "changing.json", target: "dirt.png", value: "new" }
    ]);

    assert.deepStrictEqual(index.getIncoming("stone.png"), [stable]);
    assert.deepStrictEqual(index.getIncoming("dirt.png").map(reference => reference.value), ["new"]);

    index.replaceSource("created.json", [
      { source: "created.json", target: "stone.png", parent: true, value: "created" }
    ]);
    assert.deepStrictEqual(index.getIncoming("stone.png").map(reference => reference.value), ["stable", "created"]);
    assert.deepStrictEqual(index.getChildren("stone.png").map(reference => reference.value), ["created"]);

    index.removeSource("created.json");
    assert.deepStrictEqual(index.getIncoming("stone.png"), [stable]);
    assert.deepStrictEqual(index.getChildren("stone.png"), []);
  });
});
