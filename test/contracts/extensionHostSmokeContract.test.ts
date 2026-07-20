import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("packaged Extension Host smoke contract", () => {
  const root = process.cwd();

  it("is a mandatory part of the combined VSIX verifier", () => {
    const verifier = read("scripts", "verify-main-vsix.mjs");
    assert.match(verifier, /runPackagedExtensionHostSmoke\(extensionRoot\)/);
    assert.match(verifier, /rsgl-auto-single-flight/);
    assert.doesNotMatch(verifier, /SKIP.*EXTENSION.*HOST/i);
  });

  it("loads the packaged path with isolated state and a real graphical webview", () => {
    const harness = read("scripts", "verify-extension-host-smoke.mjs");
    assert.match(harness, /工作区 with spaces/);
    assert.match(harness, /--extensionDevelopmentPath=/);
    assert.match(harness, /--extensionTestsPath=/);
    assert.match(harness, /--user-data-dir=/);
    assert.match(harness, /--extensions-dir=/);
    assert.doesNotMatch(harness, /--disable-gpu/);
  });

  it("probes off, JSON-only, lazy single-flight, screenshot, and disposal", () => {
    const runner = read("scripts", "extension-host-smoke", "run.cjs");
    const off = runner.indexOf('"rsgl.enabled",\n      "off"');
    const jsonOnly = runner.indexOf('result.stages.push("json-only-cold")');
    const auto = runner.indexOf('"rsgl.enabled",\n      "auto"');
    assert.ok(off >= 0 && jsonOnly > off && auto > jsonOnly);
    assert.match(runner, /rsglHostLoaded\(\)/);
    assert.match(runner, /lspStarts\.length === 1/);
    assert.match(runner, /McResHelper\.captureModelPreviewImage/);
    assert.match(runner, /data:image\/png;base64,iVBORw0KGgo/);
    assert.match(runner, /model-preview-interaction/);
    assert.match(runner, /includeGrid: true/);
    assert.match(runner, /workbench\.action\.closeActiveEditor/);
    assert.match(runner, /instrumentProcessStarts/);
  });

  function read(...segments: string[]): string {
    return fs.readFileSync(path.join(root, ...segments), "utf8");
  }
});
