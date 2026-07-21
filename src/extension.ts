import type * as vscode from "vscode";
import { registerCommands } from "./registration/registerCommands";
import { registerDeferredResourceSurfaces, type DeferredResourceSurfaceRegistration } from "./registration/registerDeferredResourceSurfaces";
import { registerLazyResourceInfrastructure } from "./registration/registerLazyResourceInfrastructure";
import { shutdownExtensionSubsystems } from "./registration/shutdownExtensionSubsystems";
import { registerLazyRsglSubsystem, type LazyRsglSubsystemRegistration } from "./rsgl/registerLazyRsglSubsystem";
let rsglSubsystem: LazyRsglSubsystemRegistration | undefined;
let resourceSurfaces: DeferredResourceSurfaceRegistration | undefined;
export function activate(context: vscode.ExtensionContext): void {
  const resources = registerLazyResourceInfrastructure(context);
  rsglSubsystem = registerLazyRsglSubsystem(context, resources);
  resources.navigation.setGeneratedProjectRefresher((projectId, signal) => rsglSubsystem?.refreshGeneratedProject(projectId, signal) ?? Promise.resolve(undefined));
  resourceSurfaces = registerDeferredResourceSurfaces(context, resources.navigation);
  registerCommands(context);
}
export async function deactivate(): Promise<void> {
  const surfaces = resourceSurfaces;
  resourceSurfaces = undefined;
  const subsystem = rsglSubsystem;
  rsglSubsystem = undefined;
  await shutdownExtensionSubsystems(surfaces, subsystem);
}
