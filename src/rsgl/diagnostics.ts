import * as vscode from "vscode";
import * as path from "node:path";
import { parseRsgl, RsglDiagnostic, TextRange } from "./parser";
import { compileRsglModule, compileRsglProgram, type RsglResourceValidationOptions } from "./compiler";
import { RsglWorkspaceSourceCache } from "./workspaceSource";
import { createRsglWorkspaceValidationOptions } from "./workspaceValidation";

export const rsglLanguageId = "rsgl";
export const rsglDocumentSelector: vscode.DocumentSelector = [{ language: rsglLanguageId }];

export function refreshRsglDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
  sourceCache?: RsglWorkspaceSourceCache
): void {
  if (document.languageId !== rsglLanguageId) {
    collection.delete(document.uri);
    return;
  }

  const fileName = document.uri.fsPath || document.fileName;
  if (sourceCache && fileName) {
    const files = sourceCache.loadProgramFromEntry(fileName);
    if (files.length > 0) {
      const result = compileRsglProgram(files, {
        entryFileName: fileName,
        ...workspaceValidationOptions(fileName)
      });
      const currentFileName = normalizeFileName(path.resolve(fileName));
      const diagnostics = result.diagnostics
        .filter(diagnostic => diagnostic.fileName && normalizeFileName(path.resolve(diagnostic.fileName)) === currentFileName)
        .map(toRsglDiagnostic);
      collection.set(document.uri, diagnostics.map(diagnostic => toVscodeDiagnostic(document, diagnostic)));
      return;
    }
  }

  const parsed = parseRsgl(document.getText());
  const result = compileRsglModule(parsed, {
    fileName,
    ...workspaceValidationOptions(fileName)
  });
  collection.set(document.uri, result.diagnostics.map(diagnostic => toVscodeDiagnostic(document, diagnostic)));
}

function workspaceValidationOptions(fileName: string): Pick<RsglResourceValidationOptions, "resourceExists" | "resourceContent"> {
  return createRsglWorkspaceValidationOptions({
    sourceFileName: fileName,
    defaultAssetsPath: vscode.workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath"),
    resourcePackRoots: vscode.workspace.getConfiguration().get<string[]>("McResHelper.resourcePackLoadOrder") ?? []
  });
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

function toRsglDiagnostic(diagnostic: { code: string; message: string; range: TextRange; severity: RsglDiagnostic["severity"] }): RsglDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    range: diagnostic.range,
    severity: diagnostic.severity
  };
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

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}
