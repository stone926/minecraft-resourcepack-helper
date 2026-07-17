import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("extension surface", () => {
  it("keeps activate as a thin registration orchestrator", () => {
    const source = readSource("extension.ts");

    for (const registration of [
      "registerResourceGraph(context)",
      "registerResourceDiagnostics(context)",
      "registerLanguageProviders(context)",
      "registerCommands(context)",
      "registerWorkspaceEvents(context, { diagnostics, resourceGraph })"
    ]) {
      assert.ok(source.includes(registration), `activate should delegate to ${registration}`);
    }

    for (const implementationDetail of [
      "vscode.languages.",
      "vscode.commands.",
      "createFileSystemWatcher",
      "refreshResourceDiagnostics",
      "workspaceResourceCache"
    ]) {
      assert.strictEqual(
        source.includes(implementationDetail),
        false,
        `extension.ts should not contain ${implementationDetail}`
      );
    }

    assert.ok(source.split(/\r?\n/).length <= 25, "extension.ts should remain a thin composition root");
  });

  it("defers initial diagnostics and preserves async refresh disposal", () => {
    const source = readSource("registration", "registerResourceDiagnostics.ts");

    assert.ok(source.includes("controller.refreshAllSoon();"));
    assert.ok(source.includes("void refreshResourceDiagnostics(document, this.collection);"));
    assert.ok(source.includes("disposeResourceDiagnosticsRefreshes(this.collection);"));
    assert.strictEqual(
      /context\.subscriptions\.push\(controller\);\s*controller\.refreshAll\(\)/.test(source),
      false,
      "activation should not synchronously refresh every open document"
    );
  });

  it("keeps workspace event handlers on the diagnostics controller boundary", () => {
    const source = readSource("registration", "registerWorkspaceEvents.ts");

    assert.ok(source.includes("diagnostics.refreshSoon(event.document);"));
    assert.ok(source.includes("diagnostics.refresh(document);"));
    assert.ok(source.includes("diagnostics.refreshAllSoon();"));
    assert.ok(source.includes("diagnostics.clear(document);"));
    assert.strictEqual(source.includes("refreshResourceDiagnostics("), false);
  });

  it("debounces edit-time diagnostics and texture decorations through shared metadata", () => {
    const workspaceEvents = readSource("registration", "registerWorkspaceEvents.ts");
    const diagnostics = readSource("registration", "registerResourceDiagnostics.ts");
    const decorator = readSource("decorator", "textureVarDecorator.ts");

    assert.ok(workspaceEvents.includes("scheduleDecorationRefresh(activeEditor);"));
    assert.ok(diagnostics.includes("documentRefreshTimers"));
    assert.ok(diagnostics.includes("refreshSoon(document: vscode.TextDocument"));
    assert.ok(decorator.includes("resourceConfigurationKeys.undefinedTextureVariableColor"));
    assert.ok(decorator.includes('isResourceSurfaceFile(editor.document.uri.fsPath, "textureVariables")'));
    assert.ok(decorator.includes("decorationType: vscode.TextEditorDecorationType | null = null"));
    assert.strictEqual(decorator.includes("McResHelper.tipColorForUndefinedTextureVariables"), false);
  });

  it("shares the resource-resolution configuration change predicate", () => {
    const workspaceEvents = readSource("registration", "registerWorkspaceEvents.ts");
    const modelPreviewWatcher = readSource("modelPreview", "host", "ModelPreviewWatcher.ts");

    for (const source of [workspaceEvents, modelPreviewWatcher]) {
      assert.ok(source.includes("affectsResourceResolutionConfiguration(event)"));
      assert.strictEqual(source.includes("McResHelper.defaultMcAssetsPath"), false);
      assert.strictEqual(source.includes("McResHelper.resourcePackLoadOrder"), false);
    }
  });

  it("does not equate recursive workspace watchers with trusted cache coverage", () => {
    const workspaceEvents = readSource("registration", "registerWorkspaceEvents.ts");

    assert.ok(workspaceEvents.includes("files.watcherExclude"));
    assert.ok(workspaceEvents.includes("setWatcherTrustProvider(null)"));
    assert.ok(workspaceEvents.includes("onDidDeleteFiles"));
    assert.ok(workspaceEvents.includes("onDidRenameFiles"));
    assert.ok(workspaceEvents.includes("onWillDeleteFiles"));
    assert.ok(workspaceEvents.includes("ResourceStructureOperationTracker"));
    assert.ok(workspaceEvents.includes("invalidateWorkspaceDirectoryOperation"));
    assert.strictEqual(
      workspaceEvents.includes("getWorkspaceFolder(vscode.Uri.file(fileName)) !== undefined"),
      false
    );
  });

  it("loads model preview and image export commands only when invoked", () => {
    const commands = readSource("registration", "registerCommands.ts");

    assert.ok(commands.includes('import("../modelPreview/commands/modelPreviewCommandRuntime.js")'));
    assert.strictEqual(commands.includes('from "../modelPreview/service/ModelPreviewService"'), false);
    assert.strictEqual(commands.includes('from "../modelPreview/commands/exportModelPreviewImage"'), false);
  });

  it("shares normalized open-document lookup across extension and LSP hosts", () => {
    const workspaceEvents = readSource("registration", "registerWorkspaceEvents.ts");
    const lspServer = fs.readFileSync(
      path.join(process.cwd(), "packages", "rsgl-lsp", "src", "server.ts"),
      "utf8"
    );

    for (const source of [workspaceEvents, lspServer]) {
      assert.ok(source.includes("findByNormalizedPath("));
    }
    assert.strictEqual(workspaceEvents.includes("normalizePathKey("), false);
    const openDocumentLookup = lspServer.match(
      /function findOpenDocument\([\s\S]*?\n\}/
    )?.[0] ?? "";
    assert.ok(openDocumentLookup.length > 0);
    assert.strictEqual(openDocumentLookup.includes("normalizePathKey("), false);
  });
});

function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), "src", ...segments), "utf8");
}
