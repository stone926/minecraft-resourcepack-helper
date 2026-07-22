import * as path from "node:path";
import * as vscode from "vscode";
import type { ResourcePackProjectContextDto } from "../../packages/resource-project/src";
import type { ResourcePackProjectService } from "../resourceProject";
import type {
  ResourceUniverseRefreshResult,
  ResourceUniverseService
} from "../resourceUniverse";
import { isAbortError } from "../utils/abortError";
import { affectsResourceResolutionConfiguration } from "../utils/resourceConfigurationKeys";
import type { ResourceUniverseNavigationFacade } from "../services/resourceUniverseNavigationFacade";
import {
  createInstalledRsglRuntimeLoader,
  RsglRuntimeController,
  type InstalledRsglMaterializationProject,
  type RsglRuntimeModuleImporter,
  type RsglRuntimeLoadReason
} from "./runtime";
import {
  configuredRsglMode,
  isRsglDocument,
  rsglEnablementConfiguration,
  rsglProxyCommands,
  showRsglDisabledMessage
} from "./rsglActivationSignals";

export interface RsglSubsystemRegistrationOptions {
  readonly ownsHostSignals?: boolean;
  readonly registerInContext?: boolean;
  readonly runtimeModuleImporter?: RsglRuntimeModuleImporter;
  readonly scheduleInitialSignals?: boolean;
}

export interface RsglSubsystemRegistration extends vscode.Disposable {
  readonly controller: RsglRuntimeController;
  executeCommand(command: string, args: readonly unknown[]): Promise<unknown>;
  handleDocumentSignal(
    document: vscode.TextDocument,
    reason: RsglRuntimeLoadReason
  ): Promise<void>;
  applyConfiguredMode(): Promise<void>;
  recheckKnownSignals(): Promise<void>;
  handleWorkspaceFoldersChanged(): Promise<void>;
  projectRevisionChanged(): Promise<void>;
  refreshGeneratedProject(
    projectId: string,
    signal?: AbortSignal
  ): Promise<ResourceUniverseRefreshResult | undefined>;
  shutdown(): Promise<void>;
}

/** Registers only lightweight proxies and document signals in the root bundle. */
export function registerRsglSubsystem(
  context: vscode.ExtensionContext,
  projects: ResourcePackProjectService,
  universe: ResourceUniverseService,
  navigation: ResourceUniverseNavigationFacade,
  options: RsglSubsystemRegistrationOptions = {}
): RsglSubsystemRegistration {
  const disposables: vscode.Disposable[] = [];
  const notifiedDisabledDocuments = new Set<string>();
  type GeneratedBridge = import("./rsglGeneratedContributionBridge.js").RsglGeneratedContributionBridge;
  let generatedLoad: Promise<GeneratedBridge> | undefined;
  let navigationBridgeLoad: Promise<typeof import("./rsglResourceNavigationBridge.js")> | undefined;
  let subsystemDisposed = false;
  let subsystemShutdown: Promise<void> | undefined;
  let materializationProjectHint: string | undefined;
  const controller = new RsglRuntimeController(
    createInstalledRsglRuntimeLoader(context, options.runtimeModuleImporter, {
      onMaterializationInvalidation: value =>
        getGeneratedBridge().then(generated =>
          generated.acceptMaterializationInvalidation(value, materializationProjectHint)),
      resolveMaterializationProject,
      resolveResourceNavigation: async (request, signal) => {
        const bridge = await getNavigationBridgeModule();
        return bridge.resolveRsglResourceNavigation(navigation, request, signal);
      }
    }),
    {
      mode: configuredRsglMode(),
      hasActiveProject: false,
      recheckSignals: () => queueMicrotask(() => void recheckKnownSignals())
    }
  );
  if (options.ownsHostSignals !== false) {
    for (const command of Object.values(rsglProxyCommands)) {
      disposables.push(vscode.commands.registerCommand(command, (...args: unknown[]) =>
        executeProxyCommand(command, args)
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
          void applyConfiguredMode();
        } else if (affectsResourceResolutionConfiguration(event)) {
          void controller.projectRevisionChanged();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void handleWorkspaceFoldersChanged();
      })
    );
  }

  const registration: RsglSubsystemRegistration = {
    controller,
    executeCommand: executeProxyCommand,
    handleDocumentSignal,
    applyConfiguredMode,
    recheckKnownSignals,
    handleWorkspaceFoldersChanged,
    projectRevisionChanged: () => controller.projectRevisionChanged(),
    refreshGeneratedProject: async (projectId, signal) => {
      if (signal?.aborted) {
        return undefined;
      }
      if (projects.getCachedContext(projectId)) {
        await controller.setProjectAvailable(true);
      }
      if (signal?.aborted) {
        return undefined;
      }
      const generated = await getGeneratedBridge();
      if (signal?.aborted) {
        return undefined;
      }
      return generated.refreshProject(projectId, { projectId }, signal);
    },
    dispose: () => {
      for (const disposable of disposables.splice(0)) {
        disposable.dispose();
      }
      void shutdownSubsystem();
    },
    shutdown: async () => {
      for (const disposable of disposables.splice(0)) {
        disposable.dispose();
      }
      await shutdownSubsystem();
    }
  };
  if (options.registerInContext !== false) {
    context.subscriptions.push(registration);
  }

  if (options.scheduleInitialSignals !== false) {
    queueMicrotask(() => {
      if (configuredRsglMode() === "on") {
        void discoverWorkspaceProject("configuration");
      }
      void recheckKnownSignals();
    });
  }
  return registration;

  async function executeProxyCommand(command: string, args: readonly unknown[]): Promise<unknown> {
    const mode = configuredRsglMode();
    await controller.setMode(mode);
    if (mode === "off") {
      await showRsglDisabledMessage();
      return undefined;
    }

    const targetUri = args.find(isVscodeUri)
      ?? vscode.window.activeTextEditor?.document.uri;
    const project = targetUri
      ? await resolveProject(targetUri)
      : await discoverWorkspaceProject("command");
    if (!project) {
      void vscode.window.showWarningMessage(vscode.l10n.t("RSGL command requires a resource-pack project with pack.mcmeta or rsgl.config.json."
      ));
      return undefined;
    }

    const generated = await getGeneratedBridge();
    generated.trackProject(project.projectId);
    const runtime = command === rsglProxyCommands.refreshWorkspace
      ? await generated.ensureLanguageServer(project.projectId, "manualRefresh", { retryFailed: true })
      : await controller.ensureLoaded("command", { retryFailed: true });
    if (!runtime?.executeCommand) {
      throw new Error("The integrated RSGL runtime does not expose command execution.");
    }
    const previousProjectHint = materializationProjectHint;
    materializationProjectHint = project.projectId;
    try {
      return await runtime.executeCommand(command, ...args);
    } finally {
      materializationProjectHint = previousProjectHint;
    }
  }

  async function handleDocumentSignal(
    document: vscode.TextDocument,
    reason: RsglRuntimeLoadReason
  ): Promise<void> {
    const mode = configuredRsglMode();
    await controller.setMode(mode);
    if (mode === "off") {
      if (!notifiedDisabledDocuments.has(document.uri.toString())) {
        notifiedDisabledDocuments.add(document.uri.toString());
        await showRsglDisabledMessage();
      }
      return;
    }
    const project = await resolveProject(document.uri);
    if (!project) {
      return;
    }
    let readyGenerated: GeneratedBridge | undefined;
    try {
      const generated = await getGeneratedBridge();
      generated.trackProject(project.projectId);
      await generated.ensureLanguageServer(project.projectId, reason);
      readyGenerated = generated;
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      console.error(error);
      void vscode.window.showErrorMessage(vscode.l10n.t("RSGL language server could not start: {0}",
        error instanceof Error ? error.message : String(error)
      ));
      return;
    }
    if (!readyGenerated) {
      return;
    }
    try {
      await readyGenerated.refreshProject(project.projectId);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      console.error(error);
      void vscode.window.showErrorMessage(vscode.l10n.t("RSGL generated resources could not be refreshed: {0}",
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  async function recheckKnownSignals(): Promise<void> {
    if (configuredRsglMode() === "off") {
      return;
    }
    const documents = new Map<string, vscode.TextDocument>();
    for (const document of vscode.workspace.textDocuments) {
      if (isRsglDocument(document)) {
        documents.set(document.uri.toString(), document);
      }
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (isRsglDocument(editor.document)) {
        documents.set(editor.document.uri.toString(), editor.document);
      }
    }
    for (const document of documents.values()) {
      await handleDocumentSignal(document, "visibleDocument");
    }
  }

  async function applyConfiguredMode(): Promise<void> {
    const mode = configuredRsglMode();
    await controller.setMode(mode);
    if (mode === "on") {
      await discoverWorkspaceProject("configuration");
    }
  }

  async function handleWorkspaceFoldersChanged(): Promise<void> {
    if ((vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
      await controller.setProjectAvailable(false);
    } else if (configuredRsglMode() === "on") {
      await discoverWorkspaceProject("projectMetadata");
    }
  }

  async function discoverWorkspaceProject(
    reason: RsglRuntimeLoadReason
  ): Promise<ResourcePackProjectContextDto | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const project = await resolveProject(folder.uri);
      if (project) {
        if (configuredRsglMode() === "on") {
          await controller.ensureLoaded(reason, { retryFailed: reason === "configuration" });
        }
        return project;
      }
    }
    return undefined;
  }

  async function resolveProject(
    uri: vscode.Uri
  ): Promise<ResourcePackProjectContextDto | undefined> {
    try {
      const result = await projects.resolveProject(uri.toString());
      if (!result.context) {
        return undefined;
      }
      await controller.setProjectAvailable(true);
      return result.context;
    } catch (error) {
      console.error(error);
      return undefined;
    }
  }

  async function resolveMaterializationProject(
    sourceIdentity: string,
    outputRoot: string
  ): Promise<InstalledRsglMaterializationProject | undefined> {
    const hintedProject = materializationProjectHint
      ? projects.getCachedContext(materializationProjectHint)
      : undefined;
    const project = hintedProject
      && sameNativePath(vscode.Uri.parse(hintedProject.outputPackRootUri, true), outputRoot)
      ? hintedProject
      : await resolveProject(vscode.Uri.file(sourceIdentity));
    if (!project || !sameNativePath(vscode.Uri.parse(project.outputPackRootUri, true), outputRoot)) {
      return undefined;
    }
    return {
      projectId: project.projectId,
      sourceRoot: portableSourceRoot(project),
      outputPackRootIdentity: project.localLayer.layerId
    };
  }

  function getGeneratedBridge(): Promise<GeneratedBridge> {
    if (subsystemDisposed) {
      return Promise.reject(new Error("The integrated RSGL subsystem has been disposed."));
    }
    return generatedLoad ??= import("./rsglGeneratedContributionBridge.js")
      .then(module => {
        if (subsystemDisposed) {
          throw new Error("The integrated RSGL subsystem was disposed while its bridge was loading.");
        }
        const generated = new module.RsglGeneratedContributionBridge(
          projects,
          universe,
          controller,
          {
            readTextUri: async uri => {
              try {
                return new TextDecoder().decode(
                  await vscode.workspace.fs.readFile(vscode.Uri.parse(uri, true))
                );
              } catch {
                return undefined;
              }
            },
            readBinaryUri: async uri => {
              try {
                return await vscode.workspace.fs.readFile(vscode.Uri.parse(uri, true));
              } catch {
                return undefined;
              }
            },
            listDirectoryUris: async uri => {
              try {
                const root = vscode.Uri.parse(uri, true);
                return (await vscode.workspace.fs.readDirectory(root))
                  .filter(([, type]) => (type & vscode.FileType.File) !== 0)
                  .map(([name]) => vscode.Uri.joinPath(root, name).toString());
              } catch {
                return undefined;
              }
            }
          }
        );
        return generated;
      })
      .catch(error => {
        generatedLoad = undefined;
        throw error;
      });
  }

  function getNavigationBridgeModule(): Promise<typeof import("./rsglResourceNavigationBridge.js")> {
    if (subsystemDisposed) {
      return Promise.reject(new Error("The integrated RSGL subsystem has been disposed."));
    }
    return navigationBridgeLoad ??= import("./rsglResourceNavigationBridge.js")
      .then(module => {
        if (subsystemDisposed) {
          throw new Error("The integrated RSGL subsystem was disposed while its navigation bridge was loading.");
        }
        return module;
      })
      .catch(error => {
        navigationBridgeLoad = undefined;
        throw error;
      });
  }

  function shutdownSubsystem(): Promise<void> {
    if (subsystemShutdown) {
      return subsystemShutdown;
    }
    subsystemDisposed = true;
    const generatedShutdown = generatedLoad
      ? generatedLoad.then(generated => generated.shutdown(), () => undefined)
      : Promise.resolve();
    subsystemShutdown = Promise.all([generatedShutdown, controller.dispose()]).then(() => undefined);
    return subsystemShutdown;
  }
}

export { configuredRsglMode, isRsglDocument } from "./rsglActivationSignals";

function isVscodeUri(value: unknown): value is vscode.Uri {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<vscode.Uri>;
  return typeof candidate.scheme === "string"
    && typeof candidate.path === "string"
    && typeof candidate.toString === "function";
}

function portableSourceRoot(project: ResourcePackProjectContextDto): string {
  const projectRoot = vscode.Uri.parse(project.projectRootUri, true);
  const sourceRoot = vscode.Uri.parse(project.rsglSourceRootUris[0] ?? project.projectRootUri, true);
  if (projectRoot.scheme !== sourceRoot.scheme || projectRoot.authority !== sourceRoot.authority) {
    return ".";
  }
  const relative = path.posix.relative(projectRoot.path, sourceRoot.path);
  return !relative || relative === "." || relative === ".." || relative.startsWith("../")
    ? "."
    : relative;
}

function sameNativePath(uri: vscode.Uri, fileName: string): boolean {
  const left = path.resolve(uri.fsPath);
  const right = path.resolve(fileName);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
