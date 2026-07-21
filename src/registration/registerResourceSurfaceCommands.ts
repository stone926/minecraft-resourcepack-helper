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
  register("McResHelper.refreshResourceGraph", () => resolve().resourceGraph.refresh());
  register("McResHelper.navigateResourceGraphNode", value =>
    resolve().resourceGraph.navigateNode(value)
  );
  register("McResHelper.openGeneratedResource", value =>
    resolve().resourceGraph.navigateNode(value, { preferMaterialized: false })
  );
  register("McResHelper.openMaterializedResource", value =>
    resolve().resourceGraph.navigateNode(value, { preferMaterialized: true })
  );
  register("McResHelper.showResourceConflictOwners", value =>
    resolve().resourceGraph.showConflictOwners(value)
  );
  register("McResHelper.configureVanillaSource", () =>
    resolve().resourceGraph.configureVanillaSource()
  );
  register("McResHelper.refreshResources", () => resolve().workspaceEvents.refreshResources());

  function register(command: string, handler: (...args: unknown[]) => unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  }
}
