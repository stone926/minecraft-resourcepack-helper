import * as vscode from "vscode";

export default function openDefaultMcAssetsPath() {
  const defaultPath = vscode.workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath");
  if (!defaultPath) {
    return;
  }

  vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(defaultPath), {
    "forceNewWindow": true
  });
};
