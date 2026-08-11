import * as vscode from "vscode";
import {
  normalizeRsglFormattingConfiguration,
  type RsglFormattingConfiguration
} from "../../../packages/rsgl-core/src";
import { rsglConfigKeys } from "../../../packages/rsgl-shared/src";
import {
  getConfiguredCustomResourcePackPaths,
  getConfiguredVanillaResourcePackPath
} from "../../utils/resourceConfiguration";

export function configuredVanillaResourcePackPath(scope?: vscode.ConfigurationScope): string | null {
  return getConfiguredVanillaResourcePackPath(scope);
}

export function configuredCustomResourcePackPaths(scope?: vscode.ConfigurationScope): string[] {
  return getConfiguredCustomResourcePackPaths(scope);
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
