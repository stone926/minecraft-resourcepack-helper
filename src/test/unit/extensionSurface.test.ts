import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("extension surface", () => {
  it("defers initial open-document diagnostics outside activation", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "extension.ts"), "utf8");

    assert.ok(
      source.includes("refreshOpenResourceDiagnosticsSoon();"),
      "activation should schedule the initial open-document diagnostics refresh"
    );
    assert.strictEqual(
      /context\.subscriptions\.push\(resourceDiagnostics\);\s*for\s*\(const document of vscode\.workspace\.textDocuments\)/.test(source),
      false,
      "activation should not synchronously refresh every open document"
    );
  });
});
