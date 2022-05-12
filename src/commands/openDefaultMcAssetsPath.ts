import * as vscode from "vscode";

export default function openDefaultMcAssetsPath() {
  const defaultPath = vscode.workspace.getConfiguration().get("McResHelper.defaultMcAssetsPath");
  if (defaultPath !== null) {
    vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(<string>defaultPath), {
      "forceNewWindow": true
    });
  }
};