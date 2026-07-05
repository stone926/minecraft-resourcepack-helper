import * as vscode from "vscode";
import * as path from "node:path";
import { rsglCompletionProvider } from "./completion";
import { refreshRsglDiagnostics, rsglDocumentSelector, rsglLanguageId } from "./diagnostics";
import { rsglFormattingProvider } from "./formatter";
import { RsglWorkspaceSemanticCache } from "./workspaceSemantic";
import { rsglWorkspaceSourceRootCache } from "./sourceRoot";
import { rsglWorkspaceBuildSemanticCache } from "./workspaceBuildSemantic";

export function registerRsglLanguageFeatures(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(vscode.l10n.t("McResHelper RSGL"));
  context.subscriptions.push(diagnostics);
  const semanticCache = RsglWorkspaceSemanticCache.create();
  semanticCache.setOpenTextDocumentProvider(fileName => findOpenRsglDocument(fileName));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    rsglDocumentSelector,
    rsglCompletionProvider,
    " ",
    ".",
    ":",
    "@",
    "[",
    "("
  ));

  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(
    rsglDocumentSelector,
    rsglFormattingProvider
  ));

  for (const document of vscode.workspace.textDocuments) {
    refreshRsglDiagnostics(document, diagnostics, undefined, semanticCache);
  }

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
    semanticCache.invalidatePath(document.fileName);
    refreshRsglDiagnostics(document, diagnostics, undefined, semanticCache);
    refreshOpenRsglDiagnostics(diagnostics, semanticCache, document);
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    semanticCache.invalidatePath(event.document.fileName);
    refreshRsglDiagnostics(event.document, diagnostics, undefined, semanticCache);
    refreshOpenRsglDiagnostics(diagnostics, semanticCache, event.document);
  }));

  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    semanticCache.invalidatePath(document.fileName);
    if (document.languageId === rsglLanguageId) {
      diagnostics.delete(document.uri);
      refreshOpenRsglDiagnostics(diagnostics, semanticCache, document);
    }
  }));

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.rsgl");
  context.subscriptions.push(watcher);
  const onRsglFileChange = (uri: vscode.Uri) => {
    if (uri.scheme === "file") {
      semanticCache.invalidatePath(uri.fsPath);
      rsglWorkspaceBuildSemanticCache.invalidatePath(uri.fsPath);
      rsglWorkspaceSourceRootCache.invalidatePath(uri.fsPath);
    } else {
      semanticCache.invalidateAll();
      rsglWorkspaceBuildSemanticCache.invalidateAll();
      rsglWorkspaceSourceRootCache.invalidateAll();
    }
    refreshOpenRsglDiagnostics(diagnostics, semanticCache);
  };
  watcher.onDidCreate(onRsglFileChange, null, context.subscriptions);
  watcher.onDidChange(onRsglFileChange, null, context.subscriptions);
  watcher.onDidDelete(onRsglFileChange, null, context.subscriptions);

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    rsglWorkspaceBuildSemanticCache.invalidateAll();
    rsglWorkspaceSourceRootCache.invalidateAll();
  }));
}

function refreshOpenRsglDiagnostics(
  diagnostics: vscode.DiagnosticCollection,
  semanticCache: RsglWorkspaceSemanticCache,
  except?: vscode.TextDocument
): void {
  for (const document of vscode.workspace.textDocuments) {
    if (document === except || document.languageId !== rsglLanguageId) {
      continue;
    }
    refreshRsglDiagnostics(document, diagnostics, undefined, semanticCache);
  }
}

function findOpenRsglDocument(fileName: string): vscode.TextDocument | null {
  const key = fileNameKey(fileName);
  return vscode.workspace.textDocuments.find(document =>
    document.languageId === rsglLanguageId &&
    document.uri.scheme === "file" &&
    fileNameKey(document.fileName) === key
  ) ?? null;
}

function fileNameKey(fileName: string): string {
  const normalized = path.normalize(fileName);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
