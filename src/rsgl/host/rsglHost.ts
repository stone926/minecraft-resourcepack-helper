import type * as vscode from "vscode";
import { ListenerSet } from "../../../packages/shared-utils/src/listenerSet";
import type { ResourcePackProjectService } from "../../resourceProject/resourcePackProjectService";
import type { ResourceUniverseService } from "../../resourceUniverse/core/resourceUniverseService";
import type { ResourceUniverseNavigation } from "../../services/resourceUniverseNavigation";
import type { RsglSubsystemRegistration } from "../registerRsglSubsystem";
import {
  rsglCommands,
  type RsglResourceNavigationRequest,
  type RsglResourceNavigationResponse
} from "../../../packages/rsgl-shared/src";
import type {
  RsglMaterializationInvalidation,
  RsglMaterializationProject
} from "../../../packages/rsgl-core/src/compiler";

type RsglBuildModule = typeof import("./commands/build.js");
type RsglClientModule = typeof import("./client.js");
type RsglBuildRuntime = ReturnType<RsglBuildModule["createRsglBuildCommands"]>;

export interface RsglRuntimeOptions {
  /** Retained at the bundle boundary so every runtime path has one owning extension. */
  extensionContext: vscode.ExtensionContext;
  serverPath: string;
  workerPath: string;
  stdlibRoot: string;
  signal?: AbortSignal;
  onMaterializationInvalidation?: (invalidation: RsglMaterializationInvalidation) => unknown | Promise<unknown>;
  resolveMaterializationProject?: (
    sourceIdentity: string,
    outputRoot: string
  ) => RsglMaterializationProject | undefined | Promise<RsglMaterializationProject | undefined>;
  resolveResourceNavigation?: (
    request: RsglResourceNavigationRequest,
    signal: AbortSignal
  ) => Promise<RsglResourceNavigationResponse>;
}

export interface RsglSubsystemFactoryOptions {
  extensionContext: vscode.ExtensionContext;
  projects: ResourcePackProjectService;
  universe: ResourceUniverseService;
  navigation: ResourceUniverseNavigation;
}

/** Creates the RSGL integration behind the installed feature-bundle boundary. */
export async function createRsglSubsystem(
  options: RsglSubsystemFactoryOptions
): Promise<RsglSubsystemRegistration> {
  const module = await import("../registerRsglSubsystem.js");
  return module.registerRsglSubsystem(
    options.extensionContext,
    options.projects,
    options.universe,
    options.navigation,
    {
      registerInContext: false,
      runtimeModuleImporter: async () => ({ createRsglRuntime }),
      scheduleInitialSignals: false
    }
  );
}

export interface RsglRuntime {
  ensureLanguageServer(reason?: string, signal?: AbortSignal): Promise<void>;
  requestResourceSnapshot(request: unknown, signal: AbortSignal): Promise<unknown>;
  onResourceSnapshotInvalidated(listener: (notification: unknown) => void): vscode.Disposable;
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  dispose(): Promise<void>;
}

/**
 * Creates the lazy RSGL host boundary without starting the LSP, a worker, or a watcher.
 * The root extension owns command registration and injects all installed runtime paths.
 */
export function createRsglRuntime(options: RsglRuntimeOptions): RsglRuntime {
  const paths = validateRuntimePaths(options);
  let languageServer: Awaited<ReturnType<RsglClientModule["startRsglLanguageServer"]>> | undefined;
  let languageServerInvalidationSubscription: vscode.Disposable | undefined;
  let languageServerPromise: Promise<void> | undefined;
  let buildRuntimePromise: Promise<RsglBuildRuntime> | undefined;
  let disposePromise: Promise<void> | undefined;
  let disposed = false;
  const resourceSnapshotInvalidationListeners = new ListenerSet<unknown>();

  const ensureLanguageServer = async (_reason?: string, signal?: AbortSignal): Promise<void> => {
    assertRuntimeActive(disposed, signal);
    if (languageServer) {
      return;
    }
    if (!languageServerPromise) {
      const pending = import("./client.js")
        .then(module => module.startRsglLanguageServer({
          serverPath: paths.serverPath,
          stdlibRoot: paths.stdlibRoot,
          resolveResourceNavigation: options.resolveResourceNavigation
        }))
        .then(async controller => {
          if (disposed || signal?.aborted) {
            await controller.dispose();
            throw runtimeUnavailableError(disposed, signal);
          }
          languageServerInvalidationSubscription = controller.onResourceSnapshotInvalidated(
            notification => resourceSnapshotInvalidationListeners.emit(notification)
          );
          languageServer = controller;
        })
        .finally(() => {
          if (languageServerPromise === pending) {
            languageServerPromise = undefined;
          }
        });
      languageServerPromise = pending;
    }
    await languageServerPromise;
  };

  const getBuildRuntime = () => {
    assertRuntimeActive(disposed);
    return buildRuntimePromise ??= import("./commands/build.js")
      .then(module => module.createRsglBuildCommands({
        workerPath: paths.workerPath,
        stdlibRoot: paths.stdlibRoot,
        onMaterializationInvalidation: options.onMaterializationInvalidation,
        resolveMaterializationProject: options.resolveMaterializationProject
      }));
  };

  return {
    ensureLanguageServer,
    requestResourceSnapshot: async (request, signal) => {
      assertRuntimeActive(disposed, signal);
      await ensureLanguageServer("resourceSnapshot", signal);
      assertRuntimeActive(disposed, signal);
      if (!languageServer) {
        throw new Error("The RSGL language server is not available for a resource snapshot.");
      }
      return languageServer.requestResourceSnapshot(request, signal);
    },
    onResourceSnapshotInvalidated: listener => {
      assertRuntimeActive(disposed);
      return resourceSnapshotInvalidationListeners.add(listener);
    },
    executeCommand: async (command, ...args) => {
      assertRuntimeActive(disposed);
      if (command === rsglCommands.refreshWorkspace) {
        await ensureLanguageServer("manualRefresh");
        await languageServer?.refreshWorkspace();
        return undefined;
      }
      return (await getBuildRuntime()).executeCommand(command, ...args);
    },
    dispose: () => disposePromise ??= (async () => {
      disposed = true;
      resourceSnapshotInvalidationListeners.clear();
      languageServerInvalidationSubscription?.dispose();
      languageServerInvalidationSubscription = undefined;
      const errors: unknown[] = [];

      if (buildRuntimePromise) {
        try {
          await (await buildRuntimePromise).dispose();
        } catch (error) {
          errors.push(error);
        }
      }

      if (languageServerPromise) {
        try {
          await languageServerPromise;
        } catch (error) {
          if (!isExpectedRuntimeShutdown(error)) {
            errors.push(error);
          }
        }
      }
      if (languageServer) {
        try {
          await languageServer.dispose();
        } catch (error) {
          errors.push(error);
        } finally {
          languageServer = undefined;
        }
      }

      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to dispose the RSGL runtime cleanly.");
      }
    })()
  };
}

function validateRuntimePaths(options: RsglRuntimeOptions): Pick<
  RsglRuntimeOptions,
  "serverPath" | "workerPath" | "stdlibRoot"
> {
  for (const [name, value] of Object.entries({
    serverPath: options.serverPath,
    workerPath: options.workerPath,
    stdlibRoot: options.stdlibRoot
  })) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`RSGL runtime option '${name}' must be an explicit non-empty path.`);
    }
  }
  return {
    serverPath: options.serverPath,
    workerPath: options.workerPath,
    stdlibRoot: options.stdlibRoot
  };
}

function assertRuntimeActive(disposed: boolean, signal?: AbortSignal): void {
  if (disposed || signal?.aborted) {
    throw runtimeUnavailableError(disposed, signal);
  }
}

function runtimeUnavailableError(disposed: boolean, signal?: AbortSignal): Error {
  return disposed
    ? new Error("The RSGL runtime has been disposed.")
    : signal?.reason instanceof Error
      ? signal.reason
      : new Error("RSGL runtime startup was cancelled.");
}

function isExpectedRuntimeShutdown(error: unknown): boolean {
  return error instanceof Error
    && (error.message === "The RSGL runtime has been disposed."
      || error.message === "RSGL runtime startup was cancelled.");
}
