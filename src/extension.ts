import type * as vscode from "vscode";
import { registerCommands } from "./registration/registerCommands";
import { registerLanguageProviders } from "./registration/registerLanguageProviders";
import { registerResourceDiagnostics } from "./registration/registerResourceDiagnostics";
import { registerResourceGraph } from "./registration/registerResourceGraph";
import { registerWorkspaceEvents } from "./registration/registerWorkspaceEvents";

export function activate(context: vscode.ExtensionContext): void {
  const resourceGraph = registerResourceGraph(context);
  const diagnostics = registerResourceDiagnostics(context);

  registerLanguageProviders(context);
  registerCommands(context);
  registerWorkspaceEvents(context, { diagnostics, resourceGraph });
}

export function deactivate(): void {}
