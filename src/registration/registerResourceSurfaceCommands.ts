import { contributedCommands, internalCommands } from "../commandIds";
import * as vscode from "vscode";
import type { ResourceGraphController } from "./registerResourceGraph";
import type { WorkspaceEventController } from "./registerWorkspaceEvents";

export interface ResourceSurfaceCommandTargets {
  resourceGraph: ResourceGraphController;
  workspaceEvents: WorkspaceEventController;
}

/** Registers stable command IDs while resolving the heavy resource host on demand. */
export function registerResourceSurfaceCommands(
  context: Pick<vscode.ExtensionContext, "subscriptions">,
  resolve: () => ResourceSurfaceCommandTargets
): void {
  register(contributedCommands.refreshResourceGraph, () => resolve().resourceGraph.refresh());
  register(contributedCommands.searchResourceGraph, () =>
    resolve().resourceGraph.showResourceSearch()
  );
  register(contributedCommands.followActiveResource, () =>
    resolve().resourceGraph.followActiveEditor()
  );
  register(internalCommands.navigateResourceGraphNode, value =>
    resolve().resourceGraph.navigateNode(value)
  );
  register(contributedCommands.openGeneratedResource, value =>
    resolve().resourceGraph.navigateNode(value, { preferMaterialized: false })
  );
  register(contributedCommands.openMaterializedResource, value =>
    resolve().resourceGraph.navigateNode(value, { preferMaterialized: true })
  );
  register(contributedCommands.showResourceConflictOwners, value =>
    resolve().resourceGraph.showConflictOwners(value)
  );
  register(contributedCommands.configureVanillaSource, () =>
    resolve().resourceGraph.configureVanillaSource()
  );
  register(contributedCommands.refreshResources, () => resolve().workspaceEvents.refreshResources());

  function register(command: string, handler: (...args: unknown[]) => unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  }
}
