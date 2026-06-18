import * as vscode from "vscode";
import { generateRedirectPath } from "../utils/pathGenerator";
import { getResourceReferences, rangeInsideString } from "../utils/resourceReferences";

export function refreshResourceDiagnostics(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
  if (document.languageId !== "json") {
    collection.delete(document.uri);
    return;
  }

  const diagnostics: vscode.Diagnostic[] = [];

  for (const reference of getResourceReferences(document)) {
    if (reference.value.startsWith("#")) {
      continue;
    }

    const resolvedUri = generateRedirectPath(reference.value, document, reference.target, reference.source, reference.extension);
    const range = rangeInsideString(reference.valueNode);
    if (!resolvedUri && range) {
      diagnostics.push(new vscode.Diagnostic(
        range,
        vscode.l10n.t("Minecraft resource not found: {0}", reference.value),
        vscode.DiagnosticSeverity.Warning
      ));
    }
  }

  collection.set(document.uri, diagnostics);
}
