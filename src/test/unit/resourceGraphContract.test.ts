import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("resource graph index contract", () => {
  it("builds incoming references as a shared target index instead of per-target scans", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "utils", "resourceGraph.ts"), "utf8");

    assert.ok(source.includes("collectIncomingReferencesByTarget"), "incoming references should be built as a target-key index");
    assert.ok(source.includes("referencesByTarget"), "incoming reference index should group resolved references by target key");
    assert.strictEqual(source.includes("new Map<string, Promise<ResolvedResourceReference[]>>()"), false, "incoming references should not cache one scan per target");
    assert.strictEqual(source.includes("collectIncomingReferences(targetUri"), false, "resource graph should not collect incoming references separately for each target");
    assert.strictEqual(source.includes("createIncomingReferenceSearch"), false, "incoming index should not rebuild candidate searches per target");
  });
});
