import { citLocationToLineCharacterRange } from "../utils/astLocationRanges";
import * as vscode from "vscode";
import { citResourceIdService } from "./citResourceIdService";
import { isCitPropertiesFileName } from "./citPaths";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import { localize } from "../i18n/runtime";
import { toVsCodeDiagnosticSeverity } from "../diagnostics/diagnosticSeverity";
import { toVscodeRange } from "../utils/resourceLocationVscode";
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
  const resourceIds = citResourceIdService.getResourceIdsForHotPath(
    document.fileName,
    configuration,
    options.onResourceIdsReady
      ? {
          key: `diagnostics\0${document.uri.toString()}`,
          onReady: options.onResourceIdsReady
        }
      : undefined
  );

  return getCoreCitDiagnostics(document, {
    locale: vscode.env.language,
    resourceIds
  }).map(toVsCodeDiagnostic);
}

function rangeFromCitLocation(location: CitDiagnostic["range"]): vscode.Range {
  return toVscodeRange(citLocationToLineCharacterRange(location));
}

function toVsCodeDiagnostic(diagnostic: CitDiagnostic): vscode.Diagnostic {
  return new vscode.Diagnostic(
    rangeFromCitLocation(diagnostic.range),
    localize(diagnostic.message),
    toVsCodeDiagnosticSeverity(diagnostic.severity)
  );
}
