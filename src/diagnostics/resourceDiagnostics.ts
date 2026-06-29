import * as vscode from "vscode";
import { createResourcePathResolver } from "../utils/pathGenerator";
import { getResourceReferences, isResourceReferenceDocument } from "../utils/resourceReferences";
import { rangeInsideString } from "../utils/resourceRange";
import { getSemanticResourceDiagnostics, isSemanticDiagnosticsDocument } from "./semanticDiagnostics";

export function refreshResourceDiagnostics(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
  if (!isResourceReferenceDocument(document) && !isSemanticDiagnosticsDocument(document)) {
    collection.delete(document.uri);
    return;
  }

  const diagnostics: vscode.Diagnostic[] = getSemanticResourceDiagnostics(document);
  const resolveResourcePath = createResourcePathResolver();

  for (const reference of getResourceReferences(document)) {
    if (reference.value.length === 0 || reference.value.startsWith("#")) {
      continue;
    }

    const resolvedUri = resolveResourcePath(reference.value, document, reference.target, reference.source, reference.extension);
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
