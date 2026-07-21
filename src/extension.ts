import type * as vscode from "vscode";
import { registerCommands } from "./registration/registerCommands";
import { registerLanguageProviders } from "./registration/registerLanguageProviders";
import { registerLazyResourceInfrastructure } from "./registration/registerLazyResourceInfrastructure";
import { registerResourceDiagnostics } from "./registration/registerResourceDiagnostics";
import { registerResourceGraph } from "./registration/registerResourceGraph";
import { registerWorkspaceEvents } from "./registration/registerWorkspaceEvents";
import { registerLazyRsglSubsystem, type LazyRsglSubsystemRegistration } from "./rsgl/registerLazyRsglSubsystem";
let rsglSubsystem: LazyRsglSubsystemRegistration | undefined;
export function activate(context: vscode.ExtensionContext): void {
  const resources = registerLazyResourceInfrastructure(context);
  rsglSubsystem = registerLazyRsglSubsystem(context, resources);
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
