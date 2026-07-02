import * as vscode from "vscode";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import {
  getCitDiagnostics as getCoreCitDiagnostics,
  type CitDiagnostic,
  type CitDiagnosticSeverity
} from "./citDiagnosticsCore";

export function getCitDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
  return getCoreCitDiagnostics(document, {
    locale: vscode.env.language,
    fileExists: fileName => workspaceResourceCache.getPathExists(fileName)
  }).map(toVsCodeDiagnostic);
}

function toVsCodeDiagnostic(diagnostic: CitDiagnostic): vscode.Diagnostic {
  return new vscode.Diagnostic(
    new vscode.Range(
      new vscode.Position(diagnostic.range.start.line - 1, diagnostic.range.start.column),
      new vscode.Position(diagnostic.range.end.line - 1, diagnostic.range.end.column)
    ),
    diagnostic.message,
    toVsCodeSeverity(diagnostic.severity)
  );
}

function toVsCodeSeverity(severity: CitDiagnosticSeverity): vscode.DiagnosticSeverity {
  if (severity === "error") {
    return vscode.DiagnosticSeverity.Error;
  }
  if (severity === "information") {
    return vscode.DiagnosticSeverity.Information;
  }
  return vscode.DiagnosticSeverity.Warning;
}
