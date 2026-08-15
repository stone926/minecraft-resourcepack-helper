import * as vscode from "vscode";
import { localize } from "../i18n/runtime";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import { toVscodeRange } from "../utils/resourceLocationVscode";
import { toVsCodeDiagnosticSeverity } from "./diagnosticSeverity";
import {
  getPackImageResourceIssues,
  type PackImageResourceHost
} from "./nonJsonResourceChecks";
import {
  getSemanticDiagnostics as getCoreSemanticDiagnostics,
  type SemanticDiagnostic,
  type SemanticDiagnosticsDocument,
  type SemanticDiagnosticsHost
} from "./semanticDiagnosticsCore";

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
    workspaceResourceCache.getModelParentChainResultAsync(document, ast, configuration),
  getSoundEventGraph: soundsJsonPath => workspaceResourceCache.getSoundEventGraphAsync(soundsJsonPath)
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
    toVscodeRange(diagnostic.range),
    localize(diagnostic.message),
    toVsCodeDiagnosticSeverity(diagnostic.severity)
  );
}
