import * as vscode from "vscode";
import { rsglConfigKeys } from "../../../packages/rsgl-shared/src";

export function configuredDefaultAssetsPath(): string | null {
  const rsglValue = vscode.workspace.getConfiguration().get<string | null>(rsglConfigKeys.defaultAssetsPath);
  if (typeof rsglValue === "string" && rsglValue.trim().length > 0) {
    return rsglValue;
  }
  const mainValue = vscode.workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath");
  return typeof mainValue === "string" && mainValue.trim().length > 0 ? mainValue : null;
}

export function configuredResourcePackLoadOrder(): string[] {
  const rsglValue = vscode.workspace.getConfiguration().get<string[]>(rsglConfigKeys.resourcePackLoadOrder) ?? [];
  if (rsglValue.length > 0) {
    return rsglValue;
  }
  return vscode.workspace.getConfiguration().get<string[]>("McResHelper.resourcePackLoadOrder") ?? [];
}
