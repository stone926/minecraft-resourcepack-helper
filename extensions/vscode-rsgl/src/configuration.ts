import * as vscode from "vscode";
import { rsglConfigKeys } from "../../../packages/rsgl-shared/src";

export function configuredDefaultAssetsPath(): string | null {
  const rsglValue = vscode.workspace.getConfiguration().get<string | null>(rsglConfigKeys.defaultAssetsPath);
  return typeof rsglValue === "string" && rsglValue.trim().length > 0 ? rsglValue : null;
}

export function configuredResourcePackLoadOrder(): string[] {
  return vscode.workspace.getConfiguration().get<string[]>(rsglConfigKeys.resourcePackLoadOrder) ?? [];
}
