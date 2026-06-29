import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  contributes?: {
    commands?: Array<{ command?: string; title?: string; icon?: string }>;
    menus?: Record<string, Array<{ command?: string; when?: string }>>;
  };
}

describe("model preview manifest", () => {
  it("contributes model preview commands and menus", () => {
    const packageJson = readPackageJson();
    const commands = packageJson.contributes?.commands ?? [];
    const menus = packageJson.contributes?.menus ?? {};

    assert.ok(commands.some(command => command.command === "McResHelper.openModelPreview" && command.icon === "$(preview)"));
    assert.ok(commands.some(command => command.command === "McResHelper.exportModelPreviewImage" && command.icon === "$(save-as)"));
    assert.ok(menus["editor/title"]?.some(menu => menu.command === "McResHelper.openModelPreview"));
    assert.ok(menus["editor/context"]?.some(menu => menu.command === "McResHelper.openModelPreview"));
    assert.ok(menus["editor/context"]?.some(menu => menu.command === "McResHelper.exportModelPreviewImage"));
  });

  it("ships webview static assets and vendored Three.js runtime files", () => {
    const packageJson = readPackageJson();

    assert.strictEqual(packageJson.dependencies?.three, undefined, "three should not ship through node_modules");
    assert.ok(packageJson.devDependencies?.three, "three should remain available for vendor updates");
    assert.ok(fs.existsSync(path.join(process.cwd(), "webviews", "modelPreview", "main.js")));
    assert.ok(fs.existsSync(path.join(process.cwd(), "webviews", "modelPreview", "styles.css")));
    assert.ok(fs.existsSync(path.join(process.cwd(), "webviews", "modelPreview", "vendor", "three.module.js")));
    assert.ok(fs.existsSync(path.join(process.cwd(), "webviews", "modelPreview", "vendor", "three.core.js")));
    assert.ok(fs.existsSync(path.join(process.cwd(), "webviews", "modelPreview", "vendor", "OrbitControls.js")));
    assert.ok(fs.existsSync(path.join(process.cwd(), "webviews", "modelPreview", "vendor", "THREE-LICENSE.txt")));
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
    const script = fs.readFileSync(path.join(process.cwd(), "webviews", "modelPreview", "main.js"), "utf8");
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
    assert.ok(script.includes("Math.sin(fitFov / 2)"), "perspective camera should fit using the active FOV");
    assert.ok(padding && Number(padding[1]) >= 1.35, "initial preview should leave a comfortable camera margin");
  });
});

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as PackageJson;
}
