import * as vscode from "vscode";
import * as path from "node:path";
import { rsglCompletionProvider } from "./completion";
import { refreshRsglDiagnostics, rsglDocumentSelector, rsglLanguageId } from "./diagnostics";
import { rsglFormattingProvider } from "./formatter";
import { RsglWorkspaceSourceCache } from "./workspaceSource";

export function registerRsglLanguageFeatures(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(vscode.l10n.t("McResHelper RSGL"));
  context.subscriptions.push(diagnostics);
  const sourceCache = new RsglWorkspaceSourceCache();
  sourceCache.setOpenTextDocumentProvider(fileName => findOpenRsglDocument(fileName));

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
    refreshRsglDiagnostics(document, diagnostics, sourceCache);
  }

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
    sourceCache.invalidatePath(document.fileName);
    refreshRsglDiagnostics(document, diagnostics, sourceCache);
    refreshOpenRsglDiagnostics(diagnostics, sourceCache, document);
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    sourceCache.invalidatePath(event.document.fileName);
    refreshRsglDiagnostics(event.document, diagnostics, sourceCache);
    refreshOpenRsglDiagnostics(diagnostics, sourceCache, event.document);
  }));

  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    sourceCache.invalidatePath(document.fileName);
    if (document.languageId === rsglLanguageId) {
      diagnostics.delete(document.uri);
      refreshOpenRsglDiagnostics(diagnostics, sourceCache, document);
    }
  }));

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.rsgl");
  context.subscriptions.push(watcher);
  const onRsglFileChange = (uri: vscode.Uri) => {
    if (uri.scheme === "file") {
      sourceCache.invalidatePath(uri.fsPath);
    } else {
      sourceCache.invalidateAll();
    }
    refreshOpenRsglDiagnostics(diagnostics, sourceCache);
  };
  watcher.onDidCreate(onRsglFileChange, null, context.subscriptions);
  watcher.onDidChange(onRsglFileChange, null, context.subscriptions);
  watcher.onDidDelete(onRsglFileChange, null, context.subscriptions);
}

function refreshOpenRsglDiagnostics(
  diagnostics: vscode.DiagnosticCollection,
  sourceCache: RsglWorkspaceSourceCache,
  except?: vscode.TextDocument
): void {
  for (const document of vscode.workspace.textDocuments) {
    if (document === except || document.languageId !== rsglLanguageId) {
      continue;
    }
    refreshRsglDiagnostics(document, diagnostics, sourceCache);
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
