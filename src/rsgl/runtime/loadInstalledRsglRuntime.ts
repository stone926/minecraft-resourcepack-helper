import * as path from "node:path";
import type * as vscode from "vscode";
import type { RsglMaterializationInvalidationDto } from "../../../packages/rsgl-shared/src";
import type { RsglRuntimeInstance, RsglRuntimeLoader } from "./types";

export interface InstalledRsglMaterializationProject {
  /** Canonical ResourcePackProjectContext identity. */
  projectId: string;
  /** Portable path stored in the ownership manifest, never an absolute path. */
  sourceRoot: string;
  /** Opaque identity for collision isolation; this is not a filesystem path. */
  outputPackRootIdentity: string;
}

export type InstalledRsglMaterializationInvalidation = RsglMaterializationInvalidationDto;

export interface InstalledRsglRuntimeIntegration {
  onMaterializationInvalidation?: (
    invalidation: InstalledRsglMaterializationInvalidation
  ) => unknown | Promise<unknown>;
  resolveMaterializationProject?: (
    sourceIdentity: string,
    outputRoot: string
  ) => InstalledRsglMaterializationProject | undefined | Promise<InstalledRsglMaterializationProject | undefined>;
  resolveResourceNavigation?: (
    request: unknown,
    signal: AbortSignal
  ) => Promise<unknown>;
}

export interface RsglRuntimeModule {
  createRsglRuntime(options: {
    extensionContext: vscode.ExtensionContext;
    serverPath: string;
    workerPath: string;
    stdlibRoot: string;
    signal: AbortSignal;
    onMaterializationInvalidation?: InstalledRsglRuntimeIntegration["onMaterializationInvalidation"];
    resolveMaterializationProject?: InstalledRsglRuntimeIntegration["resolveMaterializationProject"];
    resolveResourceNavigation?: InstalledRsglRuntimeIntegration["resolveResourceNavigation"];
  }): Promise<RsglRuntimeInstance> | RsglRuntimeInstance;
}

export type RsglRuntimeModuleImporter = (url: string) => Promise<unknown>;

/** Resolves all runtime paths from the one owning ExtensionContext. */
export function createInstalledRsglRuntimeLoader(
  extensionContext: vscode.ExtensionContext,
  importer: RsglRuntimeModuleImporter = importRuntimeModule,
  integration: InstalledRsglRuntimeIntegration = {}
): RsglRuntimeLoader {
  const runtimePath = extensionContext.asAbsolutePath(path.join("bundle", "features", "rsglHost.js"));
  const serverPath = extensionContext.asAbsolutePath(path.join("bundle", "rsgl", "server.js"));
  const workerPath = extensionContext.asAbsolutePath(path.join("bundle", "rsgl", "worker.js"));
  const stdlibRoot = extensionContext.asAbsolutePath(path.join("bundle", "rsgl", "stdlib"));

  return async request => {
    const { pathToFileURL } = await import("node:url");
    const loaded = await importer(pathToFileURL(runtimePath).href);
    const module = normalizeRuntimeModule(loaded);
    return module.createRsglRuntime({
      extensionContext,
      serverPath,
      workerPath,
      stdlibRoot,
      signal: request.signal,
      ...integration
    });
  };
}

export function normalizeRuntimeModule(value: unknown): RsglRuntimeModule {
  const record = asRecord(value);
  const directFactory = record?.createRsglRuntime;
  if (typeof directFactory === "function") {
    return record as unknown as RsglRuntimeModule;
  }
  const defaultExport = asRecord(record?.default);
  if (typeof defaultExport?.createRsglRuntime === "function") {
    return defaultExport as unknown as RsglRuntimeModule;
  }
  throw new Error("The installed RSGL host bundle does not export createRsglRuntime().");
}

async function importRuntimeModule(runtimeUrl: string): Promise<unknown> {
  // The non-literal URL keeps the explicitly separate CJS entry out of the root bundle.
  return import(runtimeUrl);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}
