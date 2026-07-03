import * as vscode from "vscode";
import { rsglCompletionProvider } from "./completion";
import { refreshRsglDiagnostics, rsglDocumentSelector, rsglLanguageId } from "./diagnostics";
import { rsglFormattingProvider } from "./formatter";

export function registerRsglLanguageFeatures(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(vscode.l10n.t("McResHelper RSGL"));
  context.subscriptions.push(diagnostics);

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
    refreshRsglDiagnostics(document, diagnostics);
  }

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
    refreshRsglDiagnostics(document, diagnostics);
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    refreshRsglDiagnostics(event.document, diagnostics);
  }));

  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    if (document.languageId === rsglLanguageId) {
      diagnostics.delete(document.uri);
    }
  }));
}
