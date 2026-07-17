import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("RSGL extension surface", () => {
  it("activates without exporting the removed synchronous companion API", () => {
    const extensionRoot = path.join(process.cwd(), "extensions", "vscode-rsgl");
    const extension = fs.readFileSync(path.join(extensionRoot, "src", "extension.ts"), "utf8");

    assert.strictEqual(fs.existsSync(path.join(extensionRoot, "src", "api.ts")), false);
    assert.match(extension, /activate\(context: vscode\.ExtensionContext\): void/);
    assert.strictEqual(extension.includes("createRsglApi"), false);
    assert.strictEqual(extension.includes("return createRsglApi"), false);
  });

  it("loads the language client and build commands lazily", () => {
    const extension = readExtensionSource("extension.ts");

    assert.ok(extension.includes('import("./client.js")'));
    assert.ok(extension.includes('import("./commands/build.js")'));
    assert.strictEqual(extension.includes('from "./client"'), false);
    assert.strictEqual(extension.includes('from "./commands/build"'), false);
  });

  it("owns source and dependency watchers and launches the bundled LSP", () => {
    const client = readExtensionSource("client.ts");

    assert.ok(client.includes('path.join("bundle", "server.js")'));
    assert.ok(client.includes("onDidChangeWorkspaceFolders(() => rsglWorkspaceSourceRootCache.invalidateAll())"));
    assert.ok(client.includes("rsglWatcher,"));
    assert.ok(client.includes("externalDependencyWatchers"));
    assert.ok(client.includes("patternDependencyWatchers"));
    assert.ok(client.includes("structuralDependencyWatchers"));
    assert.ok(client.includes("rsglDependencyStructureChangedNotification"));
    assert.ok(client.includes("requiredExactWatchPathsFromNotification(notification)"));
    assert.ok(client.includes("structuralDependencyWatchers.update(dependencyPaths"));
    assert.ok(client.includes("vscodeGlobDependencyWatchPattern"));
    assert.ok(client.includes("), false, true, false)"));
    assert.ok(readExtensionSource("dependencyWatch.ts").includes(
      "rebaseCompileDependencyWatchPattern as rebaseDependencyWatchPattern"
    ));
    assert.strictEqual(client.includes('createFileSystemWatcher("**/*.json")'), false);
    assert.strictEqual(client.includes("!dependencyPatterns.some"), false);
    assert.ok(client.includes("rsglRefreshWorkspaceNotification"));
    assert.ok(readExtensionSource("extension.ts").includes("rsglCommands.refreshWorkspace"));
  });
});

function readExtensionSource(...segments: string[]): string {
  return fs.readFileSync(
    path.join(process.cwd(), "extensions", "vscode-rsgl", "src", ...segments),
    "utf8"
  );
}
