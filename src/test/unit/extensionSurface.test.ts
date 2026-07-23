import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("extension surface", () => {
  it("keeps activate as a thin registration orchestrator", () => {
    const source = readSource("extension.ts");

    for (const registration of [
      "registerLazyResourceInfrastructure(context)",
      "registerLazyRsglSubsystem(context, resources)",
      "registerDeferredResourceSurfaces(context, resources.navigation)",
      "registerCommands(context)",
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
    assert.strictEqual(source.includes('from "./registration/registerResourceInfrastructure"'), false);
    assert.strictEqual(source.includes('from "./rsgl/registerRsglSubsystem"'), false);
  });

  it("defers cold resource surfaces behind synchronous command, document, and view entry points", () => {
    const source = readSource("registration", "registerDeferredResourceSurfaces.ts");

    assert.ok(source.includes("owner.start(openResourceDocuments.length > 0)"));
    assert.ok(source.includes("schedule: callback => setImmediate(callback)"));
    assert.ok(source.includes("vscode.workspace.onDidOpenTextDocument"));
    assert.ok(source.includes("isSemanticDiagnosticsDocument(document)"));
    assert.ok(source.includes("isResourceGraphDocumentPath(document.fileName)"));
    assert.ok(source.includes("new DeferredResourceGraphTreeProvider"));
    assert.ok(source.includes("vscode.window.createTreeView"));
    assert.strictEqual(source.includes("ResourceSearchViewProvider"), false);
    assert.strictEqual(source.includes("registerWebviewViewProvider"), false);
    assert.ok(source.includes("registerResourceSurfaceCommands"));
    assert.ok(source.includes("registerResourceGraph(scope, navigation)"));
    assert.ok(source.includes("registerResourceDiagnostics(scope, navigation)"));
    assert.ok(source.includes("registerLanguageProviders(scope, navigation)"));
    assert.ok(source.includes("registerWorkspaceEvents(scope"));
    assert.ok(source.includes("installation.scope.dispose()"));
  });

  it("contributes resource search as part of the single native graph view", () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "package.json"),
      "utf8"
    )) as {
      contributes?: {
        views?: Record<string, Array<Record<string, unknown>>>;
        menus?: Record<string, Array<Record<string, unknown>>>;
      };
    };
    const views = manifest.contributes?.views?.mcResHelperResources ?? [];
    const titleActions = manifest.contributes?.menus?.["view/title"] ?? [];

    assert.deepStrictEqual(views, [{
      id: "McResHelper.resourceGraph",
      name: "%view.name.resourceGraph%"
    }]);
    assert.ok(titleActions.some(item =>
      item.command === "McResHelper.searchResourceGraph"
      && item.when === "view == McResHelper.resourceGraph"
    ));
    assert.ok(titleActions.some(item =>
      item.command === "McResHelper.followActiveResource"
      && String(item.when).includes("McResHelper.resourceGraph.focusedResource")
    ));
    const deferred = readSource("registration", "registerDeferredResourceSurfaces.ts");
    assert.strictEqual(deferred.includes("registerWebviewViewProvider"), false);
  });

  it("keeps all resource command IDs on synchronous lazy proxies", () => {
    const proxies = readSource("registration", "registerResourceSurfaceCommands.ts");
    const graph = readSource("registration", "registerResourceGraph.ts");
    const workspaceEvents = readSource("registration", "registerWorkspaceEvents.ts");

    for (const command of [
      "McResHelper.refreshResourceGraph",
      "McResHelper.searchResourceGraph",
      "McResHelper.followActiveResource",
      "McResHelper.navigateResourceGraphNode",
      "McResHelper.openGeneratedResource",
      "McResHelper.openMaterializedResource",
      "McResHelper.showResourceConflictOwners",
      "McResHelper.configureVanillaSource",
      "McResHelper.refreshResources"
    ]) {
      assert.ok(proxies.includes(command), `lazy proxy should own ${command}`);
      assert.strictEqual(graph.includes(`registerCommand("${command}"`), false);
      assert.strictEqual(workspaceEvents.includes(`registerCommand("${command}"`), false);
    }
  });

  it("shuts down independent owners even when one fails", () => {
    const extension = readSource("extension.ts");
    const shutdown = readSource("registration", "shutdownExtensionSubsystems.ts");

    assert.ok(extension.includes("shutdownExtensionSubsystems(surfaces, subsystem)"));
    assert.ok(shutdown.includes("resourceSurfaces?.dispose()"));
    assert.ok(shutdown.includes("await rsglSubsystem?.shutdown()"));
    assert.ok(shutdown.includes("new AggregateError"));
  });

  it("registers project and universe infrastructure without activation-time scanning", () => {
    const source = readSource("registration", "registerResourceInfrastructure.ts");

    assert.ok(source.includes("new ResourcePackProjectService"));
    assert.ok(source.includes("new ResourceUniverseService"));
    assert.ok(source.includes("new PhysicalAssetContributionProvider"));
    assert.ok(source.includes("new ResourceUniverseNavigationFacade"));
    assert.ok(source.includes("new LazyVscodeArchiveResources"));
    assert.ok(source.includes('"**/{rsgl.config.json,pack.mcmeta}"'));
    assert.strictEqual(source.includes("findFiles("), false);
    assert.strictEqual(source.includes("scanProject("), false);
    assert.strictEqual(source.includes("new ArchiveResourceStore"), false);
  });

  it("defers initial diagnostics and preserves async refresh disposal", () => {
    const source = readSource("registration", "registerResourceDiagnostics.ts");

    assert.ok(source.includes("controller.refreshAllSoon();"));
    assert.ok(source.includes("void refreshResourceDiagnostics(document, this.collection, this.resolveReference);"));
    assert.ok(source.includes("disposeResourceDiagnosticsRefreshes(this.collection);"));
    assert.strictEqual(
      /context\.subscriptions\.push\(controller\);\s*controller\.refreshAll\(\)/.test(source),
      false,
      "activation should not synchronously refresh every open document"
    );
  });

  it("keeps workspace event handlers on the diagnostics controller boundary", () => {
    const source = readSource("registration", "registerWorkspaceEvents.ts");

    assert.ok(source.includes("getResourceWatcherGlob()"));
    assert.strictEqual(source.includes("for (const pattern of getResourceWatcherPatterns())"), false);
    assert.ok(source.includes("diagnostics.refreshSoon(event.document);"));
    assert.ok(source.includes("diagnostics.refresh(document);"));
    assert.ok(source.includes("diagnostics.refreshAllSoon();"));
    assert.ok(source.includes("diagnostics.clear(document);"));
    assert.ok(source.includes("resourceGraph.invalidateProjectDiscovery();"));
    assert.ok(source.includes("resourceGraph.invalidateProjectResolution();"));
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
