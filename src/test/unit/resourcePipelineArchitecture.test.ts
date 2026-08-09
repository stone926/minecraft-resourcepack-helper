import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("resource pipeline architecture", () => {
  it("keeps utility modules independent from stateful services and CIT features", () => {
    const utilityFiles = [
      "modelTexture.ts",
      "pathGenerator.ts",
      "resourceGraph.ts",
      "resourceGraphScan.ts",
      path.join("resourceReferences", "index.ts")
    ];
    for (const relativePath of utilityFiles) {
      const source = fs.readFileSync(path.join(process.cwd(), "src", "utils", relativePath), "utf8");
      assert.doesNotMatch(source, /["']\.\.\/services\//, relativePath);
      assert.doesNotMatch(source, /["']\.\.\/cit\//, relativePath);
      assert.strictEqual(source.includes("workspaceResourceCache"), false, relativePath);
    }
  });

  it("owns graph state and filesystem discovery in services", () => {
    const utility = fs.readFileSync(
      path.join(process.cwd(), "src", "utils", "resourceGraph.ts"),
      "utf8"
    );
    const service = fs.readFileSync(
      path.join(process.cwd(), "src", "services", "resourceGraphIndex.ts"),
      "utf8"
    );
    const scanService = fs.readFileSync(
      path.join(process.cwd(), "src", "services", "resourceGraphWorkspaceScan.ts"),
      "utf8"
    );
    assert.strictEqual(utility.includes("class ResourceGraphWorkspaceCache"), false);
    assert.strictEqual(utility.includes("class ResourceGraphIndex"), false);
    assert.ok(service.includes("class ResourceGraphWorkspaceCache"));
    assert.ok(service.includes("class ResourceGraphIndex"));
    assert.ok(scanService.includes("vscode.workspace.findFiles"));
  });

  it("lets CIT register its own reference and path adapters", () => {
    const references = fs.readFileSync(
      path.join(process.cwd(), "src", "utils", "resourceReferences", "index.ts"),
      "utf8"
    );
    const referenceRegistration = fs.readFileSync(
      path.join(process.cwd(), "src", "cit", "registerCitResourceReferences.ts"),
      "utf8"
    );
    const pathRegistration = fs.readFileSync(
      path.join(process.cwd(), "src", "cit", "registerCitResourcePaths.ts"),
      "utf8"
    );
    assert.strictEqual(references.includes("getCitPropertyReferences"), false);
    assert.ok(referenceRegistration.includes("registerResourceReferenceExtractor"));
    assert.ok(pathRegistration.includes("registerResourceReferencePathResolver"));
  });
});
