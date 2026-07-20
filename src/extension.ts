import type * as vscode from "vscode";
import { registerCommands } from "./registration/registerCommands";
import { registerLanguageProviders } from "./registration/registerLanguageProviders";
import { registerResourceDiagnostics } from "./registration/registerResourceDiagnostics";
import { registerResourceGraph } from "./registration/registerResourceGraph";
import { registerResourceInfrastructure } from "./registration/registerResourceInfrastructure";
import { registerWorkspaceEvents } from "./registration/registerWorkspaceEvents";
import { registerRsglSubsystem, type RsglSubsystemRegistration } from "./rsgl/registerRsglSubsystem";
let rsglSubsystem: RsglSubsystemRegistration | undefined;
export function activate(context: vscode.ExtensionContext): void {
  const resources = registerResourceInfrastructure(context);
  rsglSubsystem = registerRsglSubsystem(context, resources.projects, resources.universe, resources.navigation);
  resources.navigation.setGeneratedProjectRefresher((projectId, signal) => rsglSubsystem?.refreshGeneratedProject(projectId, signal) ?? Promise.resolve(undefined));
  const resourceGraph = registerResourceGraph(context, resources.navigation);
  const diagnostics = registerResourceDiagnostics(context, resources.navigation);
  registerLanguageProviders(context, resources.navigation);
  registerCommands(context);
  registerWorkspaceEvents(context, { diagnostics, resourceGraph });
}
export async function deactivate(): Promise<void> {
  const subsystem = rsglSubsystem;
  rsglSubsystem = undefined;
  await subsystem?.shutdown();
}
