import * as vscode from "vscode";
import { citResourceIdService } from "./citResourceIdService";
import { isCitPropertiesFileName } from "./citPaths";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import { localize } from "../i18n/runtime";
import { toVsCodeDiagnosticSeverity } from "../diagnostics/diagnosticSeverity";
import {
  getCitDiagnostics as getCoreCitDiagnostics,
  type CitDiagnostic
} from "./citDiagnosticsCore";

export interface CitDiagnosticsVsCodeOptions {
  onResourceIdsReady?: () => void;
}

export function getCitDiagnostics(
  document: vscode.TextDocument,
  options: CitDiagnosticsVsCodeOptions = {}
): vscode.Diagnostic[] {
  if (!isCitPropertiesFileName(document.fileName)) {
    return [];
  }

  const configuration = getResourceConfiguration();
  const cachedResourceIds = citResourceIdService.getCachedResourceIds(document.fileName, configuration);
  if (!cachedResourceIds) {
    citResourceIdService.warmResourceIds(document.fileName, configuration, options.onResourceIdsReady);
  }

  return getCoreCitDiagnostics(document, {
    locale: vscode.env.language,
    resourceIds: cachedResourceIds ?? citResourceIdService.getBuiltinResourceIds()
  }).map(toVsCodeDiagnostic);
}

function toVsCodeDiagnostic(diagnostic: CitDiagnostic): vscode.Diagnostic {
  return new vscode.Diagnostic(
    new vscode.Range(
      new vscode.Position(diagnostic.range.start.line - 1, diagnostic.range.start.column),
      new vscode.Position(diagnostic.range.end.line - 1, diagnostic.range.end.column)
    ),
    localize(diagnostic.message),
    toVsCodeDiagnosticSeverity(diagnostic.severity)
  );
}
