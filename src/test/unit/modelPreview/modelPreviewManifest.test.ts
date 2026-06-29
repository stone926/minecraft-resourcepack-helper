import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

interface PackageJson {
  dependencies?: Record<string, string>;
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

  it("ships webview static assets and the Three.js runtime dependency", () => {
    const packageJson = readPackageJson();

    assert.ok(packageJson.dependencies?.three, "three should be a runtime dependency");
    assert.ok(fs.existsSync(path.join(process.cwd(), "webviews", "modelPreview", "main.js")));
    assert.ok(fs.existsSync(path.join(process.cwd(), "webviews", "modelPreview", "styles.css")));
    assert.ok(fs.existsSync(path.join(process.cwd(), "node_modules", "three", "build", "three.module.js")));
    assert.ok(fs.existsSync(path.join(process.cwd(), "node_modules", "three", "examples", "jsm", "controls", "OrbitControls.js")));
  });
});

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as PackageJson;
}
