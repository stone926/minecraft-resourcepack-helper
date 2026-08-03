import { citLocationToLineCharacterRange } from "../utils/astLocationRanges";
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

function rangeFromCitLocation(location: CitDiagnostic["range"]): vscode.Range {
  const range = citLocationToLineCharacterRange(location);
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  );
}

function toVsCodeDiagnostic(diagnostic: CitDiagnostic): vscode.Diagnostic {
  return new vscode.Diagnostic(
    rangeFromCitLocation(diagnostic.range),
    localize(diagnostic.message),
    toVsCodeDiagnosticSeverity(diagnostic.severity)
  );
}
