import * as vscode from "vscode";
import { resourceConfigurationKeys } from "../utils/resourceConfigurationKeys";

export default function openDefaultMcAssetsPath() {
  const defaultPath = vscode.workspace.getConfiguration().get<string | null>(
    resourceConfigurationKeys.defaultAssetsPath
  );
  if (!defaultPath) {
    return;
  }

  vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(defaultPath), {
    "forceNewWindow": true
  });
};
