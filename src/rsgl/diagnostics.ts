import * as vscode from "vscode";
import { parseRsgl, RsglDiagnostic, TextRange } from "./parser";

export const rsglLanguageId = "rsgl";
export const rsglDocumentSelector: vscode.DocumentSelector = [{ language: rsglLanguageId }];

export function refreshRsglDiagnostics(document: vscode.TextDocument, collection: vscode.DiagnosticCollection): void {
  if (document.languageId !== rsglLanguageId) {
    collection.delete(document.uri);
    return;
  }

  const parsed = parseRsgl(document.getText());
  collection.set(document.uri, parsed.diagnostics.map(diagnostic => toVscodeDiagnostic(document, diagnostic)));
}

function toVscodeDiagnostic(document: vscode.TextDocument, diagnostic: RsglDiagnostic): vscode.Diagnostic {
  const vscodeDiagnostic = new vscode.Diagnostic(
    toVscodeRange(document, diagnostic.range),
    diagnostic.message,
    toVscodeSeverity(diagnostic.severity)
  );
  vscodeDiagnostic.code = diagnostic.code;
  vscodeDiagnostic.source = "RSGL";
  return vscodeDiagnostic;
}

function toVscodeSeverity(severity: RsglDiagnostic["severity"]): vscode.DiagnosticSeverity {
  if (severity === "warning") {
    return vscode.DiagnosticSeverity.Warning;
  }
  if (severity === "info") {
    return vscode.DiagnosticSeverity.Information;
  }
  return vscode.DiagnosticSeverity.Error;
}

function toVscodeRange(document: vscode.TextDocument, range: TextRange): vscode.Range {
  const start = clampOffset(document, range.start);
  const end = Math.max(start + 1, clampOffset(document, range.end));
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function clampOffset(document: vscode.TextDocument, offset: number): number {
  return Math.max(0, Math.min(document.getText().length, offset));
}
