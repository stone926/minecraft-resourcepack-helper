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
  getResourceWatcherPatterns
} from "../resources/resourceSurfaceRegistry";
import type { ResourceDiagnosticsController } from "./registerResourceDiagnostics";
import type { ResourceGraphController } from "./registerResourceGraph";

export interface WorkspaceEventRegistrations {
  diagnostics: ResourceDiagnosticsController;
  resourceGraph: ResourceGraphController;
}

export function registerWorkspaceEvents(
  context: vscode.ExtensionContext,
  registrations: WorkspaceEventRegistrations
): void {
  const { diagnostics, resourceGraph } = registrations;
  const refreshCoordinator = new ResourceRefreshCoordinator(
    workspaceResourceCache,
    diagnostics,
    resourceGraph
  );
  const resourceStructureOperations = new ResourceStructureOperationTracker({
    resourceDescendantExists: hasResourceDescendant
  });
  workspaceResourceCache.setOpenTextDocumentProvider(findOpenTextDocument);
  // These resource watchers are recursive. VS Code may apply
  // `files.watcherExclude` to them and may fold a directory deletion into one
  // parent event, so workspace membership alone is not reliable coverage.
  // Keep runtime resource reads on the short TTL/mtime verification path;
  // dedicated simple watchers can opt into hot-cache trust explicitly.
  workspaceResourceCache.setWatcherTrustProvider(null);

  let activeEditor = vscode.window.activeTextEditor;
  let decorationTimer: ReturnType<typeof setTimeout> | null = null;
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

  for (const pattern of getResourceWatcherPatterns()) {
    registerResourceWatcher(context, pattern, (uri, kind) => {
      invalidateResourcePath(uri);
      resourceGraph.invalidatePath(uri, kind);
      diagnostics.refreshAllSoon();
      resourceGraph.refreshSoon(
        undefined,
        kind !== "change" && isBlockstateDocumentPath(uri.fsPath)
      );
    });
  }

  context.subscriptions.push(
    vscode.workspace.onWillDeleteFiles(event => resourceStructureOperations.rememberBefore(
      event.files.filter(uri => uri.scheme === "file").map(uri => uri.fsPath)
    )),
    vscode.workspace.onWillRenameFiles(event => resourceStructureOperations.rememberBefore(
      event.files.filter(file => file.oldUri.scheme === "file").map(file => file.oldUri.fsPath)
    )),
    vscode.workspace.onDidCreateFiles(event => void invalidateWorkspaceDirectoryOperation(event.files)),
    vscode.workspace.onDidDeleteFiles(event => void invalidateWorkspaceDirectoryOperation(event.files)),
    vscode.workspace.onDidRenameFiles(event => void invalidateWorkspaceDirectoryOperation(
      event.files.flatMap(file => [file.oldUri, file.newUri])
    ))
  );

  vscode.workspace.onDidOpenTextDocument(document => {
    workspaceResourceCache.invalidateDocument(document);
    diagnostics.refresh(document);
    if (isResourceGraphDocumentPath(document.fileName)) {
      resourceGraph.invalidateDocument(document);
      resourceGraph.refreshSoon();
    }
  }, null, context.subscriptions);

  vscode.workspace.onDidCloseTextDocument(document => {
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

  context.subscriptions.push(vscode.commands.registerCommand(
    "McResHelper.refreshResources",
    () => refreshCoordinator.refreshAll()
  ));

  context.subscriptions.push(
    { dispose: () => {
      cancelDecorationRefresh();
      disposeDecoration();
    } },
    { dispose: () => {
      workspaceResourceCache.setOpenTextDocumentProvider(null);
      workspaceResourceCache.setWatcherTrustProvider(null);
      resourceStructureOperations.clear();
    } }
  );

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
  context: vscode.ExtensionContext,
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
