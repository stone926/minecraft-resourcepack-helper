import * as vscode from "vscode";
import type { ResourceInfrastructure } from "../registration/registerResourceInfrastructure";
import type { ResourceUniverseRefreshResult } from "../resourceUniverse/core/resourceUniverseService";
import { isAbortError } from "../utils/abortError";
import { affectsResourceResolutionConfiguration } from "../utils/resourceConfigurationKeys";
import {
  configuredRsglMode,
  isRsglDocument,
  rsglEnablementConfiguration,
  rsglProxyCommands,
  showRsglDisabledMessage
} from "./rsglActivationSignals";
import {
  createInstalledRsglSubsystemLoader,
  type InstalledRsglSubsystemLoader
} from "./loadInstalledRsglSubsystem";

type RsglSubsystemRegistration = import("./registerRsglSubsystem.js").RsglSubsystemRegistration;

export interface LazyRsglResourceInfrastructure {
  ensureResources(): Promise<ResourceInfrastructure>;
}

export interface LazyRsglSubsystemRegistration extends vscode.Disposable {
  refreshGeneratedProject(
    projectId: string,
    signal?: AbortSignal
  ): Promise<ResourceUniverseRefreshResult | undefined>;
  shutdown(): Promise<void>;
}

export interface LazyRsglSubsystemOptions {
  readonly loadSubsystem?: InstalledRsglSubsystemLoader;
}

/**
 * Owns the activation-time RSGL command and document signals while keeping the
 * runtime controller and resource infrastructure outside the root bundle.
 */
export function registerLazyRsglSubsystem(
  context: vscode.ExtensionContext,
  resources: LazyRsglResourceInfrastructure,
  options: LazyRsglSubsystemOptions = {}
): LazyRsglSubsystemRegistration {
  const disposables: vscode.Disposable[] = [];
  const notifiedDisabledDocuments = new Set<string>();
  let subsystemLoad: Promise<RsglSubsystemRegistration | undefined> | undefined;
  let subsystemLoadGeneration = -1;
  let subsystem: RsglSubsystemRegistration | undefined;
  let lifecycleGeneration = 0;
  let disposed = false;
  let initialSignalsHandle: ReturnType<typeof setImmediate> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let teardownPromise = Promise.resolve();
  const loadInstalledSubsystem = options.loadSubsystem
    ?? createInstalledRsglSubsystemLoader(context);

  for (const command of Object.values(rsglProxyCommands)) {
    disposables.push(vscode.commands.registerCommand(command, (...args: unknown[]) =>
      executeCommand(command, args)
    ));
  }
  disposables.push(
    vscode.workspace.onDidOpenTextDocument(document => {
      if (isRsglDocument(document)) {
        void handleDocumentSignal(document, "openDocument");
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const editor of editors) {
        if (isRsglDocument(editor.document)) {
          void handleDocumentSignal(editor.document, "visibleDocument");
        }
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(rsglEnablementConfiguration)) {
        runInBackground(applyConfiguredMode(), "RSGL enablement could not be updated");
      } else if (affectsResourceResolutionConfiguration(event) && (subsystem || subsystemLoad)) {
        runInBackground(
          currentSubsystem().then(registration => registration?.projectRevisionChanged()),
          "RSGL resource configuration could not be refreshed"
        );
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (subsystem || subsystemLoad || configuredRsglMode() === "on") {
        runInBackground(
          ensureSubsystem().then(registration => registration?.handleWorkspaceFoldersChanged()),
          "RSGL workspace state could not be refreshed"
        );
      }
    })
  );

  const registration: LazyRsglSubsystemRegistration = {
    refreshGeneratedProject: async (projectId, signal) => {
      if (disposed || signal?.aborted) {
        return undefined;
      }
      const loaded = await ensureSubsystem();
      if (!loaded || signal?.aborted) {
        return undefined;
      }
      return loaded.refreshGeneratedProject(projectId, signal);
    },
    dispose: () => {
      disposeSignals();
      void shutdownSubsystem().catch(error => {
        console.error("Failed to shut down the integrated RSGL subsystem.", error);
      });
    },
    shutdown: async () => {
      disposeSignals();
      await shutdownSubsystem();
    }
  };
  context.subscriptions.push(registration);

  initialSignalsHandle = setImmediate(() => {
    initialSignalsHandle = undefined;
    if (disposed) {
      return;
    }
    const mode = configuredRsglMode();
    if (mode === "on" || (mode === "auto" && hasKnownRsglDocument())) {
      runInBackground(initializeKnownSignals(), "RSGL initial signals could not be processed");
    }
  });
  return registration;

  async function executeCommand(command: string, args: readonly unknown[]): Promise<unknown> {
    if (configuredRsglMode() === "off") {
      await showRsglDisabledMessage();
      return undefined;
    }
    const loaded = await ensureSubsystem();
    return loaded?.executeCommand(command, args);
  }

  async function handleDocumentSignal(
    document: vscode.TextDocument,
    reason: "openDocument" | "visibleDocument"
  ): Promise<void> {
    if (configuredRsglMode() === "off") {
      const identity = document.uri.toString();
      if (!notifiedDisabledDocuments.has(identity)) {
        notifiedDisabledDocuments.add(identity);
        await showRsglDisabledMessage();
      }
      return;
    }
    try {
      await (await ensureSubsystem())?.handleDocumentSignal(document, reason);
    } catch (error) {
      reportBackgroundError("RSGL language server could not start", error);
    }
  }

  async function initializeKnownSignals(): Promise<void> {
    const loaded = await ensureSubsystem();
    if (!loaded) {
      return;
    }
    await loaded.applyConfiguredMode();
    if (configuredRsglMode() !== "off") {
      await loaded.recheckKnownSignals();
    }
  }

  async function applyConfiguredMode(): Promise<void> {
    const mode = configuredRsglMode();
    if (mode === "off") {
      await disableSubsystem();
      return;
    }
    if (!subsystem && !subsystemLoad && mode === "auto" && !hasKnownRsglDocument()) {
      return;
    }
    const loaded = await ensureSubsystem();
    if (!loaded) {
      return;
    }
    await loaded.applyConfiguredMode();
    await loaded.recheckKnownSignals();
  }

  function ensureSubsystem(): Promise<RsglSubsystemRegistration | undefined> {
    if (disposed || configuredRsglMode() === "off") {
      return Promise.resolve(undefined);
    }
    if (subsystem) {
      return Promise.resolve(subsystem);
    }
    if (subsystemLoad) {
      return subsystemLoadGeneration === lifecycleGeneration
        ? subsystemLoad
        : subsystemLoad.then(() => ensureSubsystem(), () => ensureSubsystem());
    }

    const loadGeneration = lifecycleGeneration;
    const pending = teardownPromise.then(async () => {
      if (!canPublish(loadGeneration)) {
        return undefined;
      }
      const infrastructure = await resources.ensureResources();
      if (!canPublish(loadGeneration)) {
        return undefined;
      }
      const loaded = await loadInstalledSubsystem(infrastructure);
      if (!canPublish(loadGeneration)) {
        await loaded.shutdown();
        return undefined;
      }
      subsystem = loaded;
      return loaded;
    });
    subsystemLoadGeneration = loadGeneration;
    subsystemLoad = pending.catch(error => {
      throw error;
    }).finally(() => {
      if (subsystemLoadGeneration === loadGeneration) {
        subsystemLoad = undefined;
        subsystemLoadGeneration = -1;
      }
    });
    return subsystemLoad;
  }

  function currentSubsystem(): Promise<RsglSubsystemRegistration | undefined> {
    return subsystem
      ? Promise.resolve(subsystem)
      : subsystemLoad ?? Promise.resolve(undefined);
  }

  function canPublish(loadGeneration: number): boolean {
    return !disposed
      && configuredRsglMode() !== "off"
      && loadGeneration === lifecycleGeneration;
  }

  async function disableSubsystem(): Promise<void> {
    lifecycleGeneration += 1;
    const loaded = subsystem;
    subsystem = undefined;
    const pending = subsystemLoad;
    const attempt = beginTeardown([
      loaded ? loaded.shutdown() : Promise.resolve(),
      pending?.then(() => undefined) ?? Promise.resolve()
    ]);
    await attempt;
  }

  function disposeSignals(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    if (initialSignalsHandle) {
      clearImmediate(initialSignalsHandle);
      initialSignalsHandle = undefined;
    }
    for (const disposable of disposables.splice(0)) {
      disposable.dispose();
    }
  }

  function shutdownSubsystem(): Promise<void> {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    lifecycleGeneration += 1;
    const loaded = subsystem;
    subsystem = undefined;
    const pending = subsystemLoad;
    shutdownPromise = beginTeardown([
      loaded ? loaded.shutdown() : Promise.resolve(),
      pending?.then(() => undefined) ?? Promise.resolve()
    ]);
    return shutdownPromise;
  }

  function beginTeardown(tasks: readonly Promise<unknown>[]): Promise<void> {
    const priorTeardown = teardownPromise;
    const attempt = Promise.all([priorTeardown, ...tasks]).then(() => undefined);
    teardownPromise = attempt.catch(() => undefined);
    return attempt;
  }
}

function hasKnownRsglDocument(): boolean {
  return vscode.workspace.textDocuments.some(isRsglDocument)
    || vscode.window.visibleTextEditors.some(editor => isRsglDocument(editor.document));
}

function runInBackground(promise: Promise<unknown>, message: string): void {
  void promise.catch(error => reportBackgroundError(message, error));
}

function reportBackgroundError(message: string, error: unknown): void {
  if (isAbortError(error)) {
    return;
  }
  console.error(message, error);
  void vscode.window.showErrorMessage(vscode.l10n.t("{0}: {1}",
    message,
    error instanceof Error ? error.message : String(error)
  ));
}
