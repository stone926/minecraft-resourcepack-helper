import * as assert from "node:assert";
import { createRequire } from "node:module";
import * as path from "node:path";

interface ClassificationModule {
  isRsglScanEvent(event: Record<string, unknown>): boolean;
}

interface RedactionModule {
  redactActivationPaths(
    value: string,
    replacements: ReadonlyArray<readonly [string, string]>,
    platform?: string
  ): string;
}

describe("activation event classification", () => {
  const repositoryRoot = path.resolve(__dirname, "../../..");
  const requireFromTest = createRequire(__filename);
  const classification = requireFromTest(
    path.join(repositoryRoot, "scripts", "activation-probe", "event-classification.cjs")
  ) as ClassificationModule;
  const redaction = requireFromTest(
    path.join(repositoryRoot, "scripts", "activation-probe", "path-redaction.cjs")
  ) as RedactionModule;

  it("detects default, recursive, caller-owned, and explicit RSGL scans", () => {
    assert.strictEqual(classification.isRsglScanEvent({ target: "<workspace>/rsgl" }), true);
    assert.strictEqual(classification.isRsglScanEvent({
      target: "<workspace>",
      recursive: true
    }), true);
    assert.strictEqual(classification.isRsglScanEvent({
      target: "<workspace>/custom-source",
      caller: "<extension>/bundle/features/rsglHost.js"
    }), true);
    assert.strictEqual(classification.isRsglScanEvent({ target: "**/*.rsgl" }), true);
    assert.strictEqual(classification.isRsglScanEvent({
      target: "<workspace>/assets",
      recursive: true,
      caller: "<extension>/bundle/extension.js"
    }), false);
  });

  it("redacts Windows extension roots without depending on path casing", () => {
    const value = "Error at e:/vscode/PROJECT/bundle/extension.js:10:2";
    assert.strictEqual(redaction.redactActivationPaths(value, [
      ["E:\\VSCode\\Project", "<extension>"]
    ], "win32"), "Error at <extension>/bundle/extension.js:10:2");
    assert.strictEqual(redaction.redactActivationPaths(value, [
      ["E:\\VSCode\\Project", "<extension>"]
    ], "linux"), value);
  });
});
