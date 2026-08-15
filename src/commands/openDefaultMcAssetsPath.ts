import * as vscode from "vscode";
import { getConfiguredVanillaResourcePackPath } from "../utils/resourceConfiguration";

export function openDefaultMcAssetsPath(): void {
  const defaultPath = getConfiguredVanillaResourcePackPath();
  if (!defaultPath) {
    return;
  }

  vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(defaultPath), {
    "forceNewWindow": true
  });
}

export default openDefaultMcAssetsPath;
