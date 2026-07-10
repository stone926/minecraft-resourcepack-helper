import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("resource path generator contract", () => {
  it("keeps path resolution on the injected host instead of a non-cache branch", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "utils", "pathGenerator.ts"), "utf8");

    assert.ok(source.includes("export interface ResourcePathResolutionHost"), "path generator should expose one injectable host interface");
    assert.ok(source.includes("resolveResourcePath(request"), "normal resources should resolve through the host");
    assert.strictEqual(source.includes("shouldUseWorkspaceCache"), false, "path generator should not retain a cache/non-cache switch");
    assert.strictEqual(source.includes("getDocumentResourceRootCandidates"), false, "path generator should not duplicate root candidate resolution");
    assert.strictEqual(source.includes("parseResourceLocation"), false, "resource location parsing should stay behind the host");
    assert.strictEqual(source.includes("fs.existsSync"), false, "path generator should not keep an uncached filesystem fallback");
    assert.strictEqual(source.includes("getPackMetadata"), false, "pack metadata should be owned by the host/cache layer");
    assert.strictEqual(source.includes("getCitPathCandidates"), false, "CIT candidates should stay behind the CIT resolver");
    assert.strictEqual(source.includes("getCitAutoDiscoveryPathCandidates"), false, "CIT auto-discovery should stay behind the CIT resolver");
    assert.strictEqual(source.includes("packRootFromAssetsPath"), false, "CIT pack lookup should stay behind the CIT resolver");
  });
});
