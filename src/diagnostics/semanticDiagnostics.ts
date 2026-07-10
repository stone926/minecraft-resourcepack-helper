import * as vscode from "vscode";
import { localize } from "../i18n/runtime";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import {
  getPackImageResourceIssues,
  type PackImageResourceHost
} from "./nonJsonResourceChecks";
import {
  getSemanticDiagnostics as getCoreSemanticDiagnostics,
  type SemanticDiagnostic,
  type SemanticDiagnosticSeverity,
  type SemanticDiagnosticsDocument,
  type SemanticDiagnosticsHost
} from "./semanticDiagnosticsCore";

export { isSemanticDiagnosticsDocument } from "./semanticDiagnosticsCore";

const packImageResourceHost: PackImageResourceHost = {
  pathExists: fileName => workspaceResourceCache.getPathExists(fileName),
  readDirectoryEntries: directory => workspaceResourceCache.getDirectoryEntriesSync(directory),
  readPngMetadata: fileName => workspaceResourceCache.getPngMetadata(fileName)
};

const semanticDiagnosticsHost: SemanticDiagnosticsHost = {
  getJsonAst: document => workspaceResourceCache.getJsonAst(document),
  readFileBytes: async fileName => {
    try {
      return await vscode.workspace.fs.readFile(vscode.Uri.file(fileName));
    } catch {
      return undefined;
    }
  },
  getPackImageResourceIssues: packRoot => getPackImageResourceIssues(packRoot, packImageResourceHost),
  getModelParentChain: (document, ast, configuration) =>
    workspaceResourceCache.getModelParentChain(document, ast, configuration),
  getSoundEvents: soundsJsonPath => workspaceResourceCache.getSoundEvents(soundsJsonPath)
};

export async function getSemanticResourceDiagnostics(
  document: SemanticDiagnosticsDocument
): Promise<vscode.Diagnostic[]> {
  const diagnostics = await getCoreSemanticDiagnostics(document, {
    configuration: getResourceConfiguration(),
    localize,
    host: semanticDiagnosticsHost
  });
  return diagnostics.map(toVsCodeDiagnostic);
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
