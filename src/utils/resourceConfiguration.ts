import * as vscode from "vscode";
import type { ResourceConfiguration } from "../services/workspaceResourceCache";

export function getResourceConfiguration(): ResourceConfiguration {
  return {
    defaultAssetsPath: vscode.workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath"),
    resourcePackRoots: vscode.workspace.getConfiguration().get<string[]>("McResHelper.resourcePackLoadOrder") ?? []
  };
}
