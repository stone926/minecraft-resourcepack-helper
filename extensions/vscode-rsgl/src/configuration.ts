import * as vscode from "vscode";

export function configuredDefaultAssetsPath(): string | null {
  const rsglValue = vscode.workspace.getConfiguration("rsgl").get<string | null>("defaultAssetsPath");
  if (typeof rsglValue === "string" && rsglValue.trim().length > 0) {
    return rsglValue;
  }
  const mainValue = vscode.workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath");
  return typeof mainValue === "string" && mainValue.trim().length > 0 ? mainValue : null;
}

export function configuredResourcePackLoadOrder(): string[] {
  const rsglValue = vscode.workspace.getConfiguration("rsgl").get<string[]>("resourcePackLoadOrder") ?? [];
  if (rsglValue.length > 0) {
    return rsglValue;
  }
  return vscode.workspace.getConfiguration().get<string[]>("McResHelper.resourcePackLoadOrder") ?? [];
}
