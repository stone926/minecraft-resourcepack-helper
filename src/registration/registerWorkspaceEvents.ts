import * as vscode from "vscode";
import { findByNormalizedPath } from "../../packages/mc-assets/src";
import {
  applyDecoration,
  disposeDecoration,
  updateDecoration
} from "../decorator/textureVarDecorator";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import {
  affectsResourceResolutionConfiguration,
  resourceConfigurationKeys
} from "../utils/resourceConfigurationKeys";
import { isResourceGraphDocumentPath } from "../utils/resourceGraphSearch";
import { getResourceWatcherPatterns } from "../resources/resourceSurfaceRegistry";
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
  workspaceResourceCache.setOpenTextDocumentProvider(findOpenTextDocument);

  let activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    applyDecoration(activeEditor);
  }

  vscode.window.onDidChangeActiveTextEditor(editor => {
    activeEditor = editor;
    if (editor) {
      applyDecoration(editor);
    }
    resourceGraph.refreshActiveEditor();
  }, null, context.subscriptions);

  vscode.workspace.onDidChangeTextDocument(event => {
    workspaceResourceCache.invalidateDocument(event.document);
    if (activeEditor && event.document === activeEditor.document) {
      applyDecoration(activeEditor);
    }
    diagnostics.refresh(event.document);
    if (isResourceGraphDocumentPath(event.document.fileName)) {
      resourceGraph.invalidateDocument(event.document);
      resourceGraph.refreshSoon();
    }
  }, null, context.subscriptions);

  for (const pattern of getResourceWatcherPatterns()) {
    registerResourceWatcher(context, pattern, uri => {
      invalidateResourcePath(uri);
      resourceGraph.invalidatePath(uri);
      diagnostics.refreshAllSoon();
      resourceGraph.refreshSoon();
    });
  }

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
      updateDecoration(activeEditor);
    }
    if (affectsResourceResolutionConfiguration(event)) {
      workspaceResourceCache.invalidateConfiguration();
      diagnostics.refreshAll();
      resourceGraph.refresh();
    }
  }));

  context.subscriptions.push(
    { dispose: disposeDecoration },
    { dispose: () => workspaceResourceCache.setOpenTextDocumentProvider(null) }
  );
}

function registerResourceWatcher(
  context: vscode.ExtensionContext,
  pattern: string,
  handleChange: (uri: vscode.Uri) => void
): void {
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  context.subscriptions.push(watcher);
  watcher.onDidCreate(handleChange, null, context.subscriptions);
  watcher.onDidChange(handleChange, null, context.subscriptions);
  watcher.onDidDelete(handleChange, null, context.subscriptions);
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
