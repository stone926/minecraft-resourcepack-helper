import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
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

  it("requires helper-free model pixels and deterministic texture colors", () => {
    const runner = read("scripts", "extension-host-smoke", "run.cjs");
    assert.match(runner, /includeGrid: false/);
    assert.match(runner, /includeAxes: false/);
    assert.match(runner, /analyzeRenderedModelPng\(screenshotBytes\)/);
    assert.match(runner, /assertRenderedCheckerTexture\(result\.screenshotAnalysis\)/);
    assert.match(runner, /assertRenderedMissingTexture\(result\.fallbackScreenshotAnalysis\)/);
    assert.match(runner, /fallbackScreenshotDataUri = fallbackPng/);
    assert.match(read("scripts", "verify-extension-host-smoke.mjs"), /options\.fallbackScreenshotOutput/);
    assert.match(runner, /model-preview-texture-fallback/);

    const requireModule = createRequire(__filename);
    const png = requireModule(path.join(root, "scripts", "extension-host-smoke", "png.cjs")) as {
      assertRenderedCheckerTexture(analysis: ScreenshotAnalysis): void;
      assertRenderedGeometry(analysis: ScreenshotAnalysis): void;
      createCheckerTexturePng(): Buffer;
      createRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer;
      analyzeRenderedModelPng(bytes: Uint8Array): ScreenshotAnalysis;
    };
    const analysis = png.analyzeRenderedModelPng(png.createCheckerTexturePng());
    assert.deepStrictEqual(analysis, {
      width: 16,
      height: 16,
      opaquePixels: 256,
      opaqueRatio: 1,
      opaqueBounds: { minX: 0, minY: 0, maxX: 15, maxY: 15, width: 16, height: 16 },
      redDominantPixels: 128,
      greenDominantPixels: 128,
      magentaDominantPixels: 0,
      blackPixels: 0
    });
    png.assertRenderedCheckerTexture(analysis);

    const transparent = png.analyzeRenderedModelPng(png.createRgbaPng(16, 16, Buffer.alloc(16 * 16 * 4)));
    assert.throws(() => png.assertRenderedGeometry(transparent), /too little opaque geometry/);

    const antialiased = Buffer.alloc(16 * 16 * 4);
    for (let pixel = 0; pixel < 16 * 16; pixel += 1) {
      antialiased[pixel * 4 + 3] = 223;
    }
    assert.strictEqual(
      png.analyzeRenderedModelPng(png.createRgbaPng(16, 16, antialiased)).opaquePixels,
      0,
      "alpha below 224 should not count as opaque geometry"
    );

    const sparseWidth = 192;
    const sparseHeight = 192;
    const sparseRgba = Buffer.alloc(sparseWidth * sparseHeight * 4);
    for (let coordinate = 0; coordinate < sparseWidth; coordinate += 1) {
      setPixel(sparseRgba, sparseWidth, coordinate, 96, [255, 0, 0, 255]);
      setPixel(sparseRgba, sparseWidth, 96, coordinate, [0, 255, 0, 255]);
    }
    const sparseLines = png.analyzeRenderedModelPng(png.createRgbaPng(sparseWidth, sparseHeight, sparseRgba));
    assert.throws(() => png.assertRenderedCheckerTexture(sparseLines), /too little opaque geometry/);

    const sentinelRgba = Buffer.alloc(100 * 100 * 4);
    for (let pixel = 0; pixel < 100 * 100; pixel += 1) {
      setPixel(sentinelRgba, 100, pixel % 100, Math.floor(pixel / 100), [128, 128, 128, 255]);
    }
    for (let pixel = 0; pixel < 19; pixel += 1) {
      setPixel(sentinelRgba, 100, pixel, 0, [255, 0, 0, 255]);
      setPixel(sentinelRgba, 100, pixel, 1, [0, 255, 0, 255]);
    }
    const belowSentinelThreshold = png.analyzeRenderedModelPng(
      png.createRgbaPng(100, 100, sentinelRgba)
    );
    assert.throws(() => png.assertRenderedCheckerTexture(belowSentinelThreshold), /checker texture colors/);
    setPixel(sentinelRgba, 100, 19, 0, [255, 0, 0, 255]);
    setPixel(sentinelRgba, 100, 19, 1, [0, 255, 0, 255]);
    png.assertRenderedCheckerTexture(png.analyzeRenderedModelPng(png.createRgbaPng(100, 100, sentinelRgba)));
  });

  it("separates host process noise without weakening extension and RSGL zero assertions", () => {
    const harness = read("scripts", "verify-extension-host-smoke.mjs");
    const runner = read("scripts", "extension-host-smoke", "run.cjs");
    const instrumentationCore = read(
      "scripts",
      "activation-probe",
      "lib",
      "instrumentation-core.cjs"
    );
    assert.match(harness, /MCRES_EXTENSION_HOST_SMOKE_EXTENSION_ROOT: resolvedExtensionRoot/);
    assert.match(instrumentationCore, /extensionOwned: isExtensionOwnedCaller\(caller\)/);
    assert.match(instrumentationCore, /rsgl: eventArguments\.some\(isRsglRuntimePath\)/);
    assert.match(runner, /assertNoExtensionProcessStarts\(processStarts, "JSON-only activation"\)/);
    assert.match(runner, /assertNoExtensionProcessStarts\(processStarts, "McResHelper\.rsgl\.enabled=off"\)/);
    assert.match(runner, /hostNoise: processStarts\.filter/);
    assert.match(runner, /\.filter\(start => start\.extensionOwned \|\| start\.rsgl\)/);
    assert.doesNotMatch(runner, /assert\(processStarts\.length === 0/);
  });

  function read(...segments: string[]): string {
    return fs.readFileSync(path.join(root, ...segments), "utf8").replaceAll("\r\n", "\n");
  }
});

interface ScreenshotAnalysis {
  width: number;
  height: number;
  opaquePixels: number;
  opaqueRatio: number;
  opaqueBounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  } | null;
  redDominantPixels: number;
  greenDominantPixels: number;
  magentaDominantPixels: number;
  blackPixels: number;
}

function setPixel(
  rgba: Buffer,
  width: number,
  x: number,
  y: number,
  [red, green, blue, alpha]: readonly number[]
): void {
  const offset = (y * width + x) * 4;
  rgba[offset] = red;
  rgba[offset + 1] = green;
  rgba[offset + 2] = blue;
  rgba[offset + 3] = alpha;
}
