import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { readCombinedModelPreviewScript, readModelPreviewScripts } from "../helpers/webviewScripts";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  contributes?: {
    commands?: Array<{ command?: string; title?: string; icon?: string }>;
    menus?: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
  };
}

const modelPreviewMenuWhen = String.raw`resourceLangId == json && resourceExtname == .json && resourceDirname =~ /[\\/]assets[\\/][^\\/]+[\\/]models(?:[\\/]|$)/`;

describe("model preview manifest", () => {
  it("contributes model preview commands and menus", () => {
    const packageJson = readPackageJson();
    const commands = packageJson.contributes?.commands ?? [];
    const menus = packageJson.contributes?.menus ?? {};
    const openEditorTitleMenu = findMenu(menus, "editor/title", "McResHelper.openModelPreview");
    const openContextMenu = findMenu(menus, "editor/context", "McResHelper.openModelPreview");
    const exportContextMenu = findMenu(menus, "editor/context", "McResHelper.exportModelPreviewImage");
    const graphPreviewMenu = findMenu(menus, "view/item/context", "McResHelper.openResourceGraphModelPreview");
    const graphUnsupportedMenu = findMenu(menus, "view/item/context", "McResHelper.openUnsupportedModelPreviewResource");

    assert.ok(commands.some(command => command.command === "McResHelper.openModelPreview" && command.icon === "$(preview)"));
    assert.ok(commands.some(command => command.command === "McResHelper.exportModelPreviewImage" && command.icon === "$(save-as)"));
    assert.ok(commands.some(command => command.command === "McResHelper.openResourceGraphModelPreview" && command.icon === "$(preview)"));
    assert.ok(commands.some(command => command.command === "McResHelper.openUnsupportedModelPreviewResource" && command.icon === "$(circle-slash)"));
    assert.strictEqual(openEditorTitleMenu?.when, modelPreviewMenuWhen);
    assert.strictEqual(openEditorTitleMenu?.group, "navigation");
    assert.strictEqual(openContextMenu?.when, modelPreviewMenuWhen);
    assert.strictEqual(exportContextMenu?.when, modelPreviewMenuWhen);
    assert.strictEqual(graphPreviewMenu?.when, "view == McResHelper.resourceGraph && viewItem == modelResource");
    assert.strictEqual(graphUnsupportedMenu?.when, "view == McResHelper.resourceGraph && viewItem == unsupportedPreviewResource");
  });

  it("keeps source behavior testable while shipping Three through the browser bundle", () => {
    const packageJson = readPackageJson();
    const scriptNames = readModelPreviewScripts().map(script => script.fileName);
    const source = readCombinedModelPreviewScript();
    const hostSource = fs.readFileSync(
      path.join(process.cwd(), "src", "modelPreview", "host", "ModelPreviewWebview.ts"),
      "utf8"
    );

    assert.strictEqual(packageJson.dependencies?.three, undefined, "three should not ship through node_modules");
    assert.ok(packageJson.devDependencies?.three, "three should remain a build-time dependency");
    for (const moduleName of [
      "main.js",
      "previewRenderer.js",
      "previewScene.js",
      "previewTextureCache.js",
      "detailsPanel.js",
      "webviewApi.js"
    ]) {
      assert.ok(scriptNames.includes(moduleName), `webview source behavior should include ${moduleName}`);
    }
    assert.ok(fs.existsSync(path.join(process.cwd(), "webviews", "modelPreview", "styles.css")));
    assert.strictEqual(fs.existsSync(path.join(process.cwd(), "webviews", "modelPreview", "vendor")), false);
    assert.strictEqual(source.includes("import * as THREE"), false);
    assert.strictEqual(source.includes("three/src/"), false);
    assert.match(source, /from "three";/);
    assert.match(source, /from "three\/addons\/controls\/OrbitControls\.js";/);
    const threeSpecifiers = [...source.matchAll(/from ["'](three(?:\/[^"']*)?)["']/g)]
      .map(match => match[1]);
    assert.ok(threeSpecifiers.length >= 3);
    assert.ok(threeSpecifiers.every(specifier =>
      specifier === "three" || specifier === "three/addons/controls/OrbitControls.js"
    ));
    assert.match(hostSource, /"bundle", "model-preview\.js"/);
    assert.strictEqual(hostSource.includes('"webviews", "modelPreview", "main.js"'), false);
    assert.strictEqual(
      fs.readFileSync(path.join(process.cwd(), "licenses", "THREE-LICENSE.txt"), "utf8"),
      fs.readFileSync(path.join(process.cwd(), "node_modules", "three", "LICENSE"), "utf8")
    );
  });

  it("registers the webview message listener before injecting HTML", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "modelPreview", "host", "ModelPreviewPanel.ts"), "utf8");
    const listenerIndex = source.indexOf("onDidReceiveMessage");
    const htmlIndex = source.indexOf("this.webview.setHtml()");

    assert.ok(listenerIndex >= 0, "ModelPreviewPanel should listen for webview messages");
    assert.ok(htmlIndex >= 0, "ModelPreviewPanel should inject webview HTML");
    assert.ok(listenerIndex < htmlIndex, "ready can be lost if HTML is injected before the message listener is registered");
  });

  it("keeps preview camera padded and the details panel adjustable", () => {
    const webviewHtml = fs.readFileSync(path.join(process.cwd(), "src", "modelPreview", "host", "ModelPreviewWebview.ts"), "utf8");
    const script = readCombinedModelPreviewScript();
    const styles = fs.readFileSync(path.join(process.cwd(), "webviews", "modelPreview", "styles.css"), "utf8");
    const padding = script.match(/const CAMERA_FIT_PADDING = ([\d.]+);/);

    assert.ok(webviewHtml.includes('id="detailsResizer"'), "details panel should expose a resize separator");
    assert.ok(webviewHtml.includes("data-details-toggle"), "issues and dependencies sections should be collapsible");
    assert.ok(styles.includes("grid-template-rows: minmax(0, 1fr) 6px"), "narrow preview layout should reserve a draggable details row");
    assert.ok(styles.includes("fit-content(25vh)"), "bottom details should default to content-driven height with a viewport cap");
    assert.ok(styles.includes(".preview-layout.details-has-manual-height"), "manual resizing should opt into a fixed details row height");
    assert.ok(styles.includes(".preview-layout.details-all-collapsed"), "collapsed bottom details should shrink the grid row");
    assert.ok(script.includes("class DetailsPanelController"), "webview should manage resize and collapse interactions");
    assert.ok(script.includes('this.layout.classList.add("details-has-manual-height")'), "dragging should switch bottom details to manual height");
    assert.strictEqual(script.includes("this.resizeFromPointer(event);"), false, "clicking the resizer should not switch to manual height");
    assert.ok(script.includes("updateCollapsedLayout()"), "details collapse state should update the outer layout");
    assert.ok(script.includes('this.panel.querySelectorAll("[data-details-section]")'), "collapse state should only inspect the details panel");
    assert.ok(script.includes('vscode.postMessage({ type: "refreshPreview" })'), "toolbar should expose a manual refresh message");
    assert.ok(script.includes("Math.sin(fitFov / 2)"), "perspective camera should fit using the active FOV");
    assert.ok(padding && Number(padding[1]) >= 1.35, "initial preview should leave a comfortable camera margin");
  });

  it("exposes clickable issue/dependency resources and structured screenshot failures", () => {
    const messageTypes = fs.readFileSync(path.join(process.cwd(), "src", "modelPreview", "host", "ModelPreviewMessages.ts"), "utf8");
    const panelSource = fs.readFileSync(path.join(process.cwd(), "src", "modelPreview", "host", "ModelPreviewPanel.ts"), "utf8");
    const script = readCombinedModelPreviewScript();

    assert.ok(messageTypes.includes('{ type: "openResource"; uri: string; range?: PreviewRange }'));
    assert.ok(messageTypes.includes('{ type: "screenshotError"; requestId: string; error: ModelPreviewError }'));
    assert.ok(panelSource.includes("openTextDocument(uri)"), "host should open text resources itself");
    assert.ok(panelSource.includes("Resource file does not exist"), "missing files should produce an explicit message");
    assert.ok(script.includes('type: "openResource"'), "webview should request host resource opening");
    assert.ok(script.includes('type: "screenshotError"'), "capture failures should reject the exact pending request");
  });

  it("supports export sizing, background options, and explicit webview disposal", () => {
    const webviewHtml = fs.readFileSync(path.join(process.cwd(), "src", "modelPreview", "host", "ModelPreviewWebview.ts"), "utf8");
    const script = readCombinedModelPreviewScript();
    const styles = fs.readFileSync(path.join(process.cwd(), "webviews", "modelPreview", "styles.css"), "utf8");

    assert.ok(webviewHtml.includes('id="exportDialog"'), "export UI should expose configurable options");
    assert.ok(webviewHtml.includes('id="exportWidth"'), "export width should be configurable");
    assert.ok(webviewHtml.includes('id="exportHeight"'), "export height should be configurable");
    assert.ok(webviewHtml.includes('id="exportTransparent"'), "transparent background should be configurable");
    assert.ok(webviewHtml.includes('id="exportBackground"'), "background color should be configurable");
    assert.ok(script.includes("backgroundColor"), "screenshot options should include a background color");
    assert.ok(script.includes("applyCameraAspect"), "captures should update projection for requested dimensions");
    assert.ok(script.includes("window.removeEventListener(\"message\""), "webview dispose should remove window listeners");
    assert.ok(script.includes("this.resizeObserver.disconnect()"), "renderer dispose should disconnect resize observer");
    assert.ok(script.includes("cancelAnimationFrame"), "renderer dispose should cancel pending animation frames");
    assert.ok(script.includes("this.webgl.forceContextLoss?.()"), "renderer dispose should release the WebGL context");
    assert.ok(styles.includes('.export-grid input[type="checkbox"]'), "export checkbox should have explicit grid alignment");
    assert.ok(styles.includes("justify-self: start"), "export checkbox should align to the left of its value column");
  });

  it("uses the Minecraft missing texture colors and quadrant layout", () => {
    const script = readCombinedModelPreviewScript();

    assert.ok(script.includes("const MISSING_TEXTURE_SIZE = 16"), "missing texture should match Minecraft's 16x16 sprite size");
    assert.ok(script.includes("const MISSING_TEXTURE_MAGENTA = [248, 0, 248]"), "missing texture should use Minecraft magenta");
    assert.ok(script.includes("const MISSING_TEXTURE_BLACK = [0, 0, 0]"), "missing texture should use Minecraft black");
    assert.ok(script.includes("(y < size / 2) !== (x < size / 2)"), "missing texture should use 2x2 quadrants, not a small checkerboard");
    assert.strictEqual(script.includes("x >> 2"), false, "missing texture should not use the old 4px checkerboard");
  });

  it("watches pack metadata used by open preview resource resolution", () => {
    const watcherSource = fs.readFileSync(
      path.join(process.cwd(), "src", "modelPreview", "host", "ModelPreviewWatcher.ts"),
      "utf8"
    );

    assert.ok(watcherSource.includes('this.watchWorkspaceFiles("**/pack.mcmeta")'));
    assert.ok(watcherSource.includes("isPackMetadataFileName(event.document.fileName)"));
    assert.ok(watcherSource.includes("onDidDeleteFiles"));
    assert.ok(watcherSource.includes("onDidRenameFiles"));
    assert.ok(watcherSource.includes("hasFileAtOrBelow"));
  });

  it("caches webview textures by dependency version instead of timestamps", () => {
    const renderer = fs.readFileSync(path.join(process.cwd(), "webviews", "modelPreview", "previewRenderer.js"), "utf8");
    const cache = fs.readFileSync(path.join(process.cwd(), "webviews", "modelPreview", "previewTextureCache.js"), "utf8");

    assert.ok(renderer.includes("new PreviewTextureCache"), "renderer should keep a texture cache across scene rebuilds");
    assert.ok(cache.includes("this.entries = new Map()"), "texture cache should own its entries");
    assert.ok(cache.includes("textureCacheKey(material)"), "renderer should key textures from material metadata");
    assert.ok(cache.includes("material.textureVersion"), "texture cache keys should include the dependency version");
    assert.strictEqual(cache.includes("Date.now()"), false, "renderer should not bypass webview caching with timestamps");
    assert.strictEqual(cache.includes("appendCacheBust"), false, "renderer should load stable texture URIs");
  });

  it("keeps missing-texture geometry visible while texture loading fails", () => {
    const renderer = fs.readFileSync(path.join(process.cwd(), "webviews", "modelPreview", "previewRenderer.js"), "utf8");
    const cache = fs.readFileSync(path.join(process.cwd(), "webviews", "modelPreview", "previewTextureCache.js"), "utf8");

    assert.match(renderer, /textureEntry\?\.state === "ready"[\s\S]+: createMissingTexture\(\)/);
    assert.match(renderer, /textureEntry\.outcome\.then\(loaded =>/);
    assert.match(renderer, /revision !== this\.sceneRevision/);
    assert.match(cache, /settle\("failed", false\)/);
    assert.match(cache, /state: "loading"/);
    assert.match(cache, /settleWithin\(outcome, TEXTURE_LOAD_SETTLE_MILLISECONDS\)/);
    assert.match(cache, /active: true/);
    assert.match(cache, /if \(!entry\.active\)/);
    assert.match(cache, /entry\.deactivate\(\)/, "prune/dispose should suppress late texture callbacks");
  });
});

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as PackageJson;
}

function findMenu(
  menus: NonNullable<NonNullable<PackageJson["contributes"]>["menus"]>,
  menuId: string,
  command: string
) {
  return menus[menuId]?.find(menu => menu.command === command);
}
