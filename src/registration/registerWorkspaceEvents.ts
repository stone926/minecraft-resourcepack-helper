import * as vscode from "vscode";
import { findByNormalizedPath } from "../../packages/mc-assets/src";
import {
  applyDecoration,
  disposeDecoration,
  updateDecoration
} from "../decorator/textureVarDecorator";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { ResourceRefreshCoordinator } from "../services/resourceRefreshCoordinator";
import { ResourceStructureOperationTracker } from "../services/resourceStructureOperationTracker";
import {
  affectsResourceResolutionConfiguration,
  resourceConfigurationKeys
} from "../utils/resourceConfigurationKeys";
import { isResourceGraphDocumentPath } from "../utils/resourceGraphSearch";
import { isBlockstateDocumentPath } from "../utils/resourceGraphScanCore";
import type { ResourceGraphPathChangeKind } from "../utils/resourceGraph";
import {
  getResourceStructureDiscoveryGlob,
  getResourceWatcherGlob
} from "../resources/resourceSurfaceRegistry";
import type { ResourceDiagnosticsController } from "./registerResourceDiagnostics";
import type { ResourceGraphController } from "./registerResourceGraph";

export interface WorkspaceEventRegistrations {
  diagnostics: ResourceDiagnosticsController;
  resourceGraph: ResourceGraphController;
}

export interface WorkspaceEventController {
  reconcileOpenedDocument(document: vscode.TextDocument): void;
  refreshResources(): void;
}

export function registerWorkspaceEvents(
  context: Pick<vscode.ExtensionContext, "subscriptions">,
  registrations: WorkspaceEventRegistrations
): WorkspaceEventController {
  const { diagnostics, resourceGraph } = registrations;
  const refreshCoordinator = new ResourceRefreshCoordinator(
    workspaceResourceCache,
    diagnostics,
    resourceGraph
  );
  const resourceStructureOperations = new ResourceStructureOperationTracker({
    resourceDescendantExists: hasResourceDescendant
  });
  const reconciledOpenDocuments = new WeakSet<vscode.TextDocument>();
  workspaceResourceCache.setOpenTextDocumentProvider(findOpenTextDocument);
  context.subscriptions.push({
    dispose: () => workspaceResourceCache.setOpenTextDocumentProvider(null)
  });
  // These resource watchers are recursive. VS Code may apply
  // `files.watcherExclude` to them and may fold a directory deletion into one
  // parent event, so workspace membership alone is not reliable coverage.
  // Keep runtime resource reads on the short TTL/mtime verification path;
  // dedicated simple watchers can opt into hot-cache trust explicitly.
  workspaceResourceCache.setWatcherTrustProvider(null);
  context.subscriptions.push({
    dispose: () => {
      workspaceResourceCache.setWatcherTrustProvider(null);
      resourceStructureOperations.clear();
    }
  });

  let activeEditor = vscode.window.activeTextEditor;
  let decorationTimer: ReturnType<typeof setTimeout> | null = null;
  context.subscriptions.push({
    dispose: () => {
      cancelDecorationRefresh();
      disposeDecoration();
    }
  });
  if (activeEditor) {
    applyDecoration(activeEditor);
  }

  vscode.window.onDidChangeActiveTextEditor(editor => {
    cancelDecorationRefresh();
    activeEditor = editor;
    if (editor) {
      applyDecoration(editor);
    }
    resourceGraph.refreshActiveEditor();
  }, null, context.subscriptions);

  vscode.workspace.onDidChangeTextDocument(event => {
    workspaceResourceCache.invalidateDocument(event.document);
    if (activeEditor && event.document === activeEditor.document) {
      scheduleDecorationRefresh(activeEditor);
    }
    diagnostics.refreshSoon(event.document);
    if (isResourceGraphDocumentPath(event.document.fileName)) {
      resourceGraph.invalidateDocument(event.document);
      resourceGraph.refreshSoon();
    }
  }, null, context.subscriptions);

  const resourceWatcherGlob = getResourceWatcherGlob();
  if (resourceWatcherGlob) {
    registerResourceWatcher(context, resourceWatcherGlob, (uri, kind) => {
      invalidateResourcePath(uri);
      resourceGraph.invalidatePath(uri, kind);
      diagnostics.refreshAllSoon();
      resourceGraph.refreshSoon(
        undefined,
        kind !== "change" && isBlockstateDocumentPath(uri.fsPath)
      );
    });
  }

  context.subscriptions.push(vscode.workspace.onWillDeleteFiles(event =>
    resourceStructureOperations.rememberBefore(
      event.files.filter(uri => uri.scheme === "file").map(uri => uri.fsPath)
    )
  ));
  context.subscriptions.push(vscode.workspace.onWillRenameFiles(event =>
    resourceStructureOperations.rememberBefore(
      event.files.filter(file => file.oldUri.scheme === "file").map(file => file.oldUri.fsPath)
    )
  ));
  context.subscriptions.push(vscode.workspace.onDidCreateFiles(event =>
    void invalidateWorkspaceDirectoryOperation(event.files)
  ));
  context.subscriptions.push(vscode.workspace.onDidDeleteFiles(event =>
    void invalidateWorkspaceDirectoryOperation(event.files)
  ));
  context.subscriptions.push(vscode.workspace.onDidRenameFiles(event =>
    void invalidateWorkspaceDirectoryOperation(
      event.files.flatMap(file => [file.oldUri, file.newUri])
    )
  ));

  const reconcileOpenedDocument = (document: vscode.TextDocument): void => {
    if (reconciledOpenDocuments.has(document)) {
      return;
    }
    reconciledOpenDocuments.add(document);
    workspaceResourceCache.invalidateDocument(document);
    diagnostics.refresh(document);
    if (isResourceGraphDocumentPath(document.fileName)) {
      resourceGraph.invalidateDocument(document);
      resourceGraph.refreshSoon();
    }
  };
  vscode.workspace.onDidOpenTextDocument(
    reconcileOpenedDocument,
    null,
    context.subscriptions
  );

  vscode.workspace.onDidCloseTextDocument(document => {
    reconciledOpenDocuments.delete(document);
    workspaceResourceCache.invalidateDocument(document);
    diagnostics.clear(document);
    if (isResourceGraphDocumentPath(document.fileName)) {
      resourceGraph.invalidatePath(document.uri);
      resourceGraph.refreshSoon();
    }
  }, null, context.subscriptions);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(resourceConfigurationKeys.undefinedTextureVariableColor) && activeEditor) {
      cancelDecorationRefresh();
      updateDecoration(activeEditor);
    }
    if (affectsResourceResolutionConfiguration(event)) {
      workspaceResourceCache.invalidateConfiguration();
      diagnostics.refreshAll();
      resourceGraph.refresh();
    }
  }));

  return {
    reconcileOpenedDocument,
    refreshResources: () => refreshCoordinator.refreshAll()
  };

  function scheduleDecorationRefresh(editor: vscode.TextEditor, delay = 120): void {
    cancelDecorationRefresh();
    decorationTimer = setTimeout(() => {
      decorationTimer = null;
      if (activeEditor === editor) {
        applyDecoration(editor);
      }
    }, delay);
  }

  function cancelDecorationRefresh(): void {
    if (decorationTimer) {
      clearTimeout(decorationTimer);
      decorationTimer = null;
    }
  }

  async function invalidateWorkspaceDirectoryOperation(uris: readonly vscode.Uri[]): Promise<void> {
    const fileNames = uris.filter(uri => uri.scheme === "file").map(uri => uri.fsPath);
    if (!(await resourceStructureOperations.consumeAfter(fileNames))) {
      return;
    }
    workspaceResourceCache.invalidateAll();
    diagnostics.refreshAllSoon();
    resourceGraph.refreshSoon(undefined, true);
  }
}

async function hasResourceDescendant(directory: string): Promise<boolean> {
  const pattern = new vscode.RelativePattern(
    vscode.Uri.file(directory),
    getResourceStructureDiscoveryGlob()
  );
  return (await vscode.workspace.findFiles(pattern, null, 1)).length > 0;
}

function registerResourceWatcher(
  context: Pick<vscode.ExtensionContext, "subscriptions">,
  pattern: string,
  handleChange: (uri: vscode.Uri, kind: ResourceGraphPathChangeKind) => void
): void {
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  context.subscriptions.push(watcher);
  watcher.onDidCreate(uri => handleChange(uri, "create"), null, context.subscriptions);
  watcher.onDidChange(uri => handleChange(uri, "change"), null, context.subscriptions);
  watcher.onDidDelete(uri => handleChange(uri, "delete"), null, context.subscriptions);
}

function invalidateResourcePath(uri: vscode.Uri): void {
  if (uri.scheme === "file") {
    workspaceResourceCache.invalidatePath(uri.fsPath);
  } else {
    workspaceResourceCache.invalidateAll();
  }
}

function findOpenTextDocument(fileName: string): vscode.TextDocument | null {
  return findByNormalizedPath(
    vscode.workspace.textDocuments,
    fileName,
    document => document.uri.scheme === "file" ? document.fileName : null
  ) ?? null;
}
