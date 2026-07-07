import * as vscode from "vscode";
import { lm } from "../i18n/messages";
import { localize } from "../i18n/runtime";
import { createResourceReferencePathResolver } from "../utils/pathGenerator";
import { getResourceReferences, isResourceReferenceDocument } from "../utils/resourceReferences";
import { rangeInsideString } from "../utils/resourceRange";
import { getCitDiagnostics } from "../cit/citDiagnostics";
import { getSemanticResourceDiagnostics, isSemanticDiagnosticsDocument } from "./semanticDiagnostics";

const resolveResourcePath = createResourceReferencePathResolver();

export function refreshResourceDiagnostics(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
  if (!isResourceReferenceDocument(document) && !isSemanticDiagnosticsDocument(document)) {
    collection.delete(document.uri);
    return;
  }

  const diagnostics: vscode.Diagnostic[] = [
    ...getSemanticResourceDiagnostics(document),
    ...getCitDiagnostics(document)
  ];

  for (const reference of getResourceReferences(document)) {
    if (reference.value.length === 0 || reference.value.startsWith("#")) {
      continue;
    }

    const resolvedUri = resolveResourcePath(reference, document);
    const range = rangeInsideString(reference.valueNode);
    if (!resolvedUri && range) {
      diagnostics.push(new vscode.Diagnostic(
        range,
        localize(lm("Minecraft resource not found: {0}", reference.value)),
        vscode.DiagnosticSeverity.Warning
      ));
    }
  }

  collection.set(document.uri, diagnostics);
}
