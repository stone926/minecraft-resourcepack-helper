import * as vscode from "vscode";
import { normalizePathKey } from "../../../packages/mc-assets/src";
import { rsglCompletionProvider } from "./completion";
import { refreshRsglDiagnostics, rsglDocumentSelector, rsglLanguageId } from "./diagnostics";
import { rsglFormattingProvider } from "./formatter";
import { RsglWorkspaceSemanticCache } from "../../../packages/rsgl-core/src/workspaceSemantic";
import { rsglWorkspaceSourceRootCache } from "../../../packages/rsgl-core/src/sourceRoot";
import { rsglWorkspaceBuildSemanticCache } from "../../../packages/rsgl-core/src/workspaceBuildSemantic";
import { createRsglSemanticTokensProvider, rsglSemanticTokensLegend } from "./semanticTokens";
import { startRsglLanguageServer } from "./client";

export function registerRsglLanguageFeatures(context: vscode.ExtensionContext): void {
  if (startRsglLanguageServer(context)) {
    return;
  }

  registerInProcessRsglLanguageFeatures(context);
}

function registerInProcessRsglLanguageFeatures(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(vscode.l10n.t("RSGL"));
  context.subscriptions.push(diagnostics);
  const semanticCache = RsglWorkspaceSemanticCache.create();
  semanticCache.setOpenTextDocumentProvider(fileName => findOpenRsglDocument(fileName));
  const semanticTokensChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(semanticTokensChanged);

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

  context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider(
    rsglDocumentSelector,
    createRsglSemanticTokensProvider(semanticCache, semanticTokensChanged.event),
    rsglSemanticTokensLegend
  ));

  for (const document of vscode.workspace.textDocuments) {
    refreshRsglDiagnostics(document, diagnostics, undefined, semanticCache);
  }

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
    semanticCache.invalidatePath(document.fileName);
    refreshRsglDiagnostics(document, diagnostics, undefined, semanticCache);
    refreshOpenRsglDiagnostics(diagnostics, semanticCache, document);
    if (document.languageId === rsglLanguageId) {
      semanticTokensChanged.fire();
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    semanticCache.invalidatePath(event.document.fileName);
    refreshRsglDiagnostics(event.document, diagnostics, undefined, semanticCache);
    refreshOpenRsglDiagnostics(diagnostics, semanticCache, event.document);
    if (event.document.languageId === rsglLanguageId) {
      semanticTokensChanged.fire();
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    semanticCache.invalidatePath(document.fileName);
    if (document.languageId === rsglLanguageId) {
      diagnostics.delete(document.uri);
      refreshOpenRsglDiagnostics(diagnostics, semanticCache, document);
      semanticTokensChanged.fire();
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
    semanticTokensChanged.fire();
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
  const key = normalizePathKey(fileName);
  return vscode.workspace.textDocuments.find(document =>
    document.languageId === rsglLanguageId &&
    document.uri.scheme === "file" &&
    normalizePathKey(document.fileName) === key
  ) ?? null;
}
