import * as vscode from "vscode";
import { localize } from "../i18n/runtime";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import {
  getSemanticDiagnostics as getCoreSemanticDiagnostics,
  type SemanticDiagnostic,
  type SemanticDiagnosticSeverity,
  type SemanticDiagnosticsDocument
} from "./semanticDiagnosticsCore";

export { isSemanticDiagnosticsDocument } from "./semanticDiagnosticsCore";

export function getSemanticResourceDiagnostics(document: SemanticDiagnosticsDocument): vscode.Diagnostic[] {
  return getCoreSemanticDiagnostics(document, {
    configuration: getResourceConfiguration(),
    localize
  }).map(toVsCodeDiagnostic);
}

function toVsCodeDiagnostic(diagnostic: SemanticDiagnostic): vscode.Diagnostic {
  return new vscode.Diagnostic(
    new vscode.Range(
      new vscode.Position(diagnostic.range.start.line, diagnostic.range.start.character),
      new vscode.Position(diagnostic.range.end.line, diagnostic.range.end.character)
    ),
    localize(diagnostic.message),
    toVsCodeSeverity(diagnostic.severity)
  );
}

function toVsCodeSeverity(severity: SemanticDiagnosticSeverity): vscode.DiagnosticSeverity {
  return severity === "information"
    ? vscode.DiagnosticSeverity.Information
    : vscode.DiagnosticSeverity.Warning;
}
