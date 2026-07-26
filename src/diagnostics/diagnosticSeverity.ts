import * as vscode from "vscode";

/**
 * Maps the vscode-free diagnostic severity strings shared by the CIT and
 * semantic cores onto the VS Code enum. Unknown values fall back to Warning.
 */
export function toVsCodeDiagnosticSeverity(
  severity: "error" | "warning" | "information"
): vscode.DiagnosticSeverity {
  if (severity === "error") {
    return vscode.DiagnosticSeverity.Error;
  }
  if (severity === "information") {
    return vscode.DiagnosticSeverity.Information;
  }
  return vscode.DiagnosticSeverity.Warning;
}
