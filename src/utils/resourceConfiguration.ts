import * as vscode from "vscode";
import type { ResourceConfiguration } from "../services/resourceCacheTypes";
import { resourceConfigurationKeys } from "./resourceConfigurationKeys";

export function getResourceConfiguration(): ResourceConfiguration {
  return {
    defaultAssetsPath: vscode.workspace.getConfiguration().get<string | null>(
      resourceConfigurationKeys.defaultAssetsPath
    ),
    resourcePackRoots: vscode.workspace.getConfiguration().get<string[]>(
      resourceConfigurationKeys.resourcePackLoadOrder
    ) ?? []
  };
}
