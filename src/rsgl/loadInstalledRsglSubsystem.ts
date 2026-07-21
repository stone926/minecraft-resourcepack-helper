import type * as vscode from "vscode";
import type { ResourceInfrastructure } from "../registration/registerResourceInfrastructure";
import type { RsglSubsystemRegistration } from "./registerRsglSubsystem";

export interface InstalledRsglSubsystemModule {
  createRsglSubsystem(options: {
    extensionContext: vscode.ExtensionContext;
    projects: ResourceInfrastructure["projects"];
    universe: ResourceInfrastructure["universe"];
    navigation: ResourceInfrastructure["navigation"];
  }): RsglSubsystemRegistration | Promise<RsglSubsystemRegistration>;
}

export type RsglSubsystemModuleImporter = (url: string) => Promise<unknown>;

export type InstalledRsglSubsystemLoader = (
  resources: ResourceInfrastructure
) => Promise<RsglSubsystemRegistration>;

export function createInstalledRsglSubsystemLoader(
  extensionContext: vscode.ExtensionContext,
  importer: RsglSubsystemModuleImporter = importSubsystemModule
): InstalledRsglSubsystemLoader {
  const subsystemPath = extensionContext.asAbsolutePath("bundle/features/rsglHost.js");
  return async resources => {
    const { pathToFileURL } = await import("node:url");
    const loaded = await importer(pathToFileURL(subsystemPath).href);
    return normalizeSubsystemModule(loaded).createRsglSubsystem({
      extensionContext,
      projects: resources.projects,
      universe: resources.universe,
      navigation: resources.navigation
    });
  };
}

export function normalizeSubsystemModule(value: unknown): InstalledRsglSubsystemModule {
  const record = asRecord(value);
  if (typeof record?.createRsglSubsystem === "function") {
    return record as unknown as InstalledRsglSubsystemModule;
  }
  const defaultExport = asRecord(record?.default);
  if (typeof defaultExport?.createRsglSubsystem === "function") {
    return defaultExport as unknown as InstalledRsglSubsystemModule;
  }
  throw new Error("The installed RSGL host bundle does not export createRsglSubsystem().");
}

async function importSubsystemModule(subsystemUrl: string): Promise<unknown> {
  // A variable URL preserves the explicitly separate CJS feature entry.
  return import(subsystemUrl);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}
