import type * as vscode from "vscode";
import { moduleExportWithFunction } from "../../packages/shared-utils/src";
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
  const module = moduleExportWithFunction(value, "createRsglSubsystem");
  if (module) {
    return module as unknown as InstalledRsglSubsystemModule;
  }
  throw new Error("The installed RSGL host bundle does not export createRsglSubsystem().");
}

async function importSubsystemModule(subsystemUrl: string): Promise<unknown> {
  // A variable URL preserves the explicitly separate CJS feature entry.
  return import(subsystemUrl);
}
