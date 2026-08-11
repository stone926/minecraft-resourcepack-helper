import * as vscode from "vscode";
import type { ResourceConfiguration } from "./resourceConfigurationTypes";
import { resourceConfigurationKeys } from "./resourceConfigurationKeys";

const explicitConfigurationFields = [
  "globalValue",
  "workspaceValue",
  "workspaceFolderValue",
  "globalLanguageValue",
  "workspaceLanguageValue",
  "workspaceFolderLanguageValue"
] as const;

export function getResourceConfiguration(
  scope?: vscode.ConfigurationScope
): ResourceConfiguration {
  const configuration = vscode.workspace.getConfiguration(undefined, scope);
  return {
    defaultAssetsPath: configuredVanillaResourcePackPath(configuration),
    resourcePackRoots: configuredCustomResourcePackPaths(configuration)
  };
}

export function getConfiguredVanillaResourcePackPath(
  scope?: vscode.ConfigurationScope
): string | null {
  return configuredVanillaResourcePackPath(
    vscode.workspace.getConfiguration(undefined, scope)
  );
}

export function getConfiguredCustomResourcePackPaths(
  scope?: vscode.ConfigurationScope
): string[] {
  return configuredCustomResourcePackPaths(
    vscode.workspace.getConfiguration(undefined, scope)
  );
}

function configuredVanillaResourcePackPath(
  configuration: vscode.WorkspaceConfiguration
): string | null {
  if (isExplicitlyConfigured(configuration, resourceConfigurationKeys.vanillaResourcePackPath)) {
    return normalizedPath(configuration.get<string | null>(
      resourceConfigurationKeys.vanillaResourcePackPath
    ));
  }

  const legacyValue = normalizedPath(configuration.get<string | null>(
    resourceConfigurationKeys.legacyDefaultMcAssetsPath
  ));
  return legacyValue ?? normalizedPath(configuration.get<string | null>(
    resourceConfigurationKeys.vanillaResourcePackPath
  ));
}

function configuredCustomResourcePackPaths(
  configuration: vscode.WorkspaceConfiguration
): string[] {
  if (isExplicitlyConfigured(configuration, resourceConfigurationKeys.customResourcePackPaths)) {
    return normalizedPathArray(configuration.get<unknown>(
      resourceConfigurationKeys.customResourcePackPaths
    ));
  }

  const legacyValue = normalizedPathArray(configuration.get<unknown>(
    resourceConfigurationKeys.legacyResourcePackLoadOrder
  ));
  return legacyValue.length > 0
    ? legacyValue
    : normalizedPathArray(configuration.get<unknown>(
      resourceConfigurationKeys.customResourcePackPaths
    ));
}

function isExplicitlyConfigured(
  configuration: vscode.WorkspaceConfiguration,
  section: string
): boolean {
  const inspection = configuration.inspect?.<unknown>(section);
  return inspection !== undefined && explicitConfigurationFields.some(
    field => inspection[field] !== undefined
  );
}

function normalizedPath(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizedPathArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
