import * as vscode from "vscode";
import {
  normalizeRsglFormattingConfiguration,
  type RsglFormattingConfiguration
} from "../../../packages/rsgl-core/src";
import { rsglConfigKeys } from "../../../packages/rsgl-shared/src";

export function configuredDefaultAssetsPath(scope?: vscode.ConfigurationScope): string | null {
  const rsglValue = vscode.workspace.getConfiguration(undefined, scope)
    .get<string | null>(rsglConfigKeys.defaultAssetsPath);
  return typeof rsglValue === "string" && rsglValue.trim().length > 0 ? rsglValue : null;
}

export function configuredResourcePackLoadOrder(scope?: vscode.ConfigurationScope): string[] {
  return vscode.workspace.getConfiguration(undefined, scope)
    .get<string[]>(rsglConfigKeys.resourcePackLoadOrder) ?? [];
}

export function configuredRsglFormatting(
  uri?: vscode.Uri
): RsglFormattingConfiguration {
  const configuration = vscode.workspace.getConfiguration(undefined, {
    uri,
    languageId: "rsgl"
  });
  return normalizeRsglFormattingConfiguration({
    style: configuration.get(rsglConfigKeys.style),
    lineWidth: configuration.get(rsglConfigKeys.lineWidth),
    braceStyle: configuration.get(rsglConfigKeys.braceStyle)
  });
}
