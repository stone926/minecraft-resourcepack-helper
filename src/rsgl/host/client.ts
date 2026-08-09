import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { abortSignalError } from "../../../packages/shared-utils/src";
import {
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  LanguageClient,
  SemanticTokensRegistrationType,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions
} from "vscode-languageclient/node";
import {
  isRsglResourceSnapshotInvalidationNotification,
  isRsglResourceSnapshotRequest,
  isRsglResourceNavigationRequest,
  isRsglResourceNavigationResponse,
  rsglDependencyPathsNotification,
  rsglDependencyStructureChangedNotification,
  rsglConfigKeys,
  rsglFileGlob,
  rsglRefreshWorkspaceNotification,
  rsglResourceNavigationProtocolVersion,
  rsglResourceNavigationRequest,
  rsglResourceSnapshotInvalidatedNotification,
  rsglResourceSnapshotRequest,
  type RsglDependencyPathsNotification,
  type RsglDependencyWatchPattern,
  type RsglResourceNavigationRequest,
  type RsglResourceNavigationResponse,
  type RsglResourceSnapshotInvalidationNotification,
  type RsglResourceSnapshotRequest
} from "../../../packages/rsgl-shared/src";
import type { RsglFormattingConfiguration } from "../../../packages/rsgl-core/src";
import { rsglWorkspaceSourceRootCache } from "../../../packages/rsgl-core/src/sourceRoot";
import {
  configuredDefaultAssetsPath,
  configuredResourcePackLoadOrder,
  configuredRsglFormatting
} from "./configuration";
import {
  DependencyPatternWatchRegistry,
  DependencyWatchRegistry,
  dependencyPatternProbePath,
  isValidDependencyWatchPattern,
  requiresExactDependencyWatcher,
  vscodeExactDependencyWatchPattern,
  vscodeGlobDependencyWatchPattern
} from "./dependencyWatch";
import {
  DependencyStructureWatchRegistry,
  type DependencyStructureWatchSelector
} from "./dependencyStructureWatch";
import {
  provideRsglSemanticTokens,
  RsglSemanticTokenReplayCache
} from "./semanticTokenReplayCache";

interface RsglValidationSettings {
  stdlibRoot: string;
  defaultAssetsPath: string | null;
  resourcePackRoots: string[];
  formatting: RsglFormattingConfiguration;
  workspaceFolders: Array<{
    workspaceFolderUri: string;
    workspaceFolderPath: string;
    defaultAssetsPath: string | null;
    resourcePackRoots: string[];
    formatting: RsglFormattingConfiguration;
  }>;
}

export interface RsglLanguageServerController {
  refreshWorkspace(): Promise<void>;
  requestResourceSnapshot(
    request: unknown,
    signal?: AbortSignal
  ): Promise<unknown>;
  onResourceSnapshotInvalidated(
    listener: (notification: RsglResourceSnapshotInvalidationNotification) => void
  ): vscode.Disposable;
  dispose(): Promise<void>;
}

export interface RsglLanguageServerOptions {
  serverPath: string;
  stdlibRoot: string;
  resolveResourceNavigation?: (
    request: RsglResourceNavigationRequest,
    signal: AbortSignal
  ) => Promise<RsglResourceNavigationResponse>;
}

export async function startRsglLanguageServer(
  options: RsglLanguageServerOptions
): Promise<RsglLanguageServerController> {
  if (!fs.existsSync(options.serverPath)) {
    throw new Error(`RSGL language server file does not exist: ${options.serverPath}`);
  }

  const serverOptions: ServerOptions = {
    run: { module: options.serverPath, transport: TransportKind.ipc },
    debug: { module: options.serverPath, transport: TransportKind.ipc }
  };
  const rsglWatcher = vscode.workspace.createFileSystemWatcher(rsglFileGlob);
  const semanticTokenReplayCache = new RsglSemanticTokenReplayCache();
  const hostDisposables: vscode.Disposable[] = [rsglWatcher];
  const resourceSnapshotInvalidationListeners = new Set<(
    notification: RsglResourceSnapshotInvalidationNotification
  ) => void>();
  let disposed = false;
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "rsgl" },
      { scheme: "vscode-remote", language: "rsgl" }
    ],
    initializationOptions: () => currentRsglValidationSettings(options.stdlibRoot),
    middleware: {
      provideDocumentSemanticTokens: (document, token, next) => {
        const uri = document.uri.toString();
        const text = document.getText();
        return provideRsglSemanticTokens(semanticTokenReplayCache, {
          uri,
          text,
          isCancellationRequested: () => token.isCancellationRequested,
          next: () => next(document, token),
          createReplay: replay => new vscode.SemanticTokens(replay.data, replay.resultId)
        });
      }
    },
    synchronize: {
      fileEvents: [rsglWatcher]
    }
  };
  const client = new LanguageClient("rsgl", "RSGL", serverOptions, clientOptions);
  hostDisposables.push(vscode.window.onDidChangeVisibleTextEditors(editors => {
    // Preview replacement creates a fresh editor model. Wake the provider only
    // after that model is visible so VS Code does not defer its attachment retry.
    const emitters = new Set<vscode.EventEmitter<void>>();
    for (const editor of editors) {
      const document = editor.document;
      if (document.languageId !== "rsgl") {
        continue;
      }
      const provider = client
        .getFeature(SemanticTokensRegistrationType.method)
        .getProvider(document);
      if (
        provider
        && semanticTokenReplayCache.claimImmediateRefresh(document.uri.toString())
      ) {
        emitters.add(provider.onDidChangeSemanticTokensEmitter);
      }
    }
    for (const emitter of emitters) {
      emitter.fire();
    }
  }));
  hostDisposables.push(client.onRequest(
    rsglResourceNavigationRequest,
    async (value: unknown, token: vscode.CancellationToken) => {
      if (!isRsglResourceNavigationRequest(value)) {
        throw new TypeError("The RSGL resource navigation request failed its runtime guard.");
      }
      if (token.isCancellationRequested) {
        return cancelledResourceNavigationResponse(value);
      }
      if (!options.resolveResourceNavigation) {
        return unavailableResourceNavigationResponse(value);
      }
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      try {
        const response = await options.resolveResourceNavigation(value, controller.signal);
        if (!isRsglResourceNavigationResponse(response)
          || response.requestGeneration !== value.requestGeneration
          || response.operation !== value.operation) {
          throw new TypeError("The RSGL resource navigation response failed its runtime guard.");
        }
        return response;
      } finally {
        cancellation.dispose();
      }
    }
  ));
  hostDisposables.push(client.onNotification(
    rsglResourceSnapshotInvalidatedNotification,
    (value: unknown) => {
      if (!isRsglResourceSnapshotInvalidationNotification(value)) {
        return;
      }
      for (const listener of resourceSnapshotInvalidationListeners) {
        listener(value);
      }
    }
  ));
  hostDisposables.push(
    vscode.workspace.onDidOpenTextDocument(document => {
      if (document.languageId === "rsgl") {
        semanticTokenReplayCache.prepareOpen(document.uri.toString(), document.getText());
      }
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === "rsgl" && event.contentChanges.length > 0) {
        semanticTokenReplayCache.invalidateAll();
      }
    }),
    rsglWatcher.onDidCreate(uri => {
      semanticTokenReplayCache.invalidateAll();
      rsglWorkspaceSourceRootCache.invalidatePath(uri.fsPath);
    }),
    rsglWatcher.onDidChange(() => semanticTokenReplayCache.invalidateAll()),
    rsglWatcher.onDidDelete(uri => {
      semanticTokenReplayCache.invalidateAll();
      rsglWorkspaceSourceRootCache.invalidatePath(uri.fsPath);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      semanticTokenReplayCache.invalidateAll();
      rsglWorkspaceSourceRootCache.invalidateAll();
      void client.sendNotification(DidChangeConfigurationNotification.type, {
        settings: currentRsglValidationSettings(options.stdlibRoot)
      });
    })
  );
  const sendDependencyChange = (uri: vscode.Uri, type: FileChangeType) => {
    semanticTokenReplayCache.invalidateAll();
    void client.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: uri.toString(), type }]
    });
  };
  const sendDependencyStructureChange = (uri: vscode.Uri) => {
    semanticTokenReplayCache.invalidateAll();
    void client.sendNotification(rsglDependencyStructureChangedNotification, {
      paths: [uri.fsPath]
    });
  };
  const externalDependencyWatchers = new DependencyWatchRegistry(fileName => {
    const watchPattern = vscodeExactDependencyWatchPattern(fileName, isExistingDirectory);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
      vscode.Uri.file(watchPattern.basePath),
      watchPattern.pattern
    ));
    watcher.onDidCreate(uri => sendDependencyChange(uri, FileChangeType.Created));
    watcher.onDidChange(uri => sendDependencyChange(uri, FileChangeType.Changed));
    watcher.onDidDelete(uri => sendDependencyChange(uri, FileChangeType.Deleted));
    return watcher;
  });
  const patternDependencyWatchers = new DependencyPatternWatchRegistry(pattern => {
    const watchPattern = vscodeGlobDependencyWatchPattern(pattern, isExistingDirectory);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
      vscode.Uri.file(watchPattern.basePath),
      watchPattern.pattern
    ));
    watcher.onDidCreate(uri => sendDependencyChange(uri, FileChangeType.Created));
    watcher.onDidChange(uri => sendDependencyChange(uri, FileChangeType.Changed));
    watcher.onDidDelete(uri => sendDependencyChange(uri, FileChangeType.Deleted));
    return watcher;
  });
  const structuralDependencyWatchers = new DependencyStructureWatchRegistry(selector => {
    const watchPattern = structuralWatchPattern(selector);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
      vscode.Uri.file(watchPattern.basePath),
      watchPattern.pattern
    ), false, true, false);
    watcher.onDidCreate(uri => {
      if (structuralDependencyWatchers.shouldForwardEvent(
        uri.fsPath,
        "create",
        isExistingDirectory(uri.fsPath)
      )) {
        sendDependencyStructureChange(uri);
      }
    });
    watcher.onDidDelete(uri => {
      if (structuralDependencyWatchers.shouldForwardEvent(uri.fsPath, "delete", false)) {
        sendDependencyStructureChange(uri);
      }
    });
    return watcher;
  });
  const dependencyNotification = client.onNotification(
    rsglDependencyPathsNotification,
    (notification: RsglDependencyPathsNotification) => {
      const dependencyPatterns = dependencyPatternsFromNotification(notification);
      const dependencyPaths = dependencyPathsFromNotification(notification);
      const exactPaths = requiredExactWatchPathsFromNotification(notification)
        .filter(fileName => requiresExactDependencyWatcher(
          fileName,
          Boolean(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fileName)))
        ));
      const update = externalDependencyWatchers.update(exactPaths);
      const patternUpdate = patternDependencyWatchers.update(dependencyPatterns);
      structuralDependencyWatchers.update(dependencyPaths, dependencyPatterns);
      const addedDependencyPaths = [
        ...update.added,
        ...patternUpdate.added.map(dependencyPatternProbePath)
      ];
      if (addedDependencyPaths.length > 0) {
        if (addedDependencyPaths.some(invalidatesRsglSemanticTokens)) {
          semanticTokenReplayCache.invalidateAll();
        }
        void client.sendNotification(DidChangeWatchedFilesNotification.type, {
          changes: addedDependencyPaths.map(fileName => ({
            uri: vscode.Uri.file(fileName).toString(),
            type: FileChangeType.Changed
          }))
        });
      }
    }
  );
  hostDisposables.push(vscode.workspace.onDidChangeConfiguration(event => {
    const semanticResolutionChanged = event.affectsConfiguration(rsglConfigKeys.defaultAssetsPath)
      || event.affectsConfiguration(rsglConfigKeys.resourcePackLoadOrder);
    if (
      semanticResolutionChanged
      || event.affectsConfiguration(rsglConfigKeys.style)
      || event.affectsConfiguration(rsglConfigKeys.lineWidth)
      || event.affectsConfiguration(rsglConfigKeys.braceStyle)
    ) {
      if (semanticResolutionChanged) {
        semanticTokenReplayCache.invalidateAll();
      }
      void client.sendNotification(DidChangeConfigurationNotification.type, {
        settings: currentRsglValidationSettings(options.stdlibRoot)
      });
    }
  }));
  hostDisposables.push(
    dependencyNotification,
    externalDependencyWatchers,
    patternDependencyWatchers,
    structuralDependencyWatchers
  );

  try {
    await client.start();
  } catch (error) {
    disposeHostDisposables(hostDisposables);
    throw error;
  }

  let disposePromise: Promise<void> | undefined;
  return {
    refreshWorkspace: async () => {
      if (disposed) {
        throw new Error("The RSGL language server has been disposed.");
      }
      semanticTokenReplayCache.invalidateAll();
      rsglWorkspaceSourceRootCache.invalidateAll();
      await client.sendNotification(rsglRefreshWorkspaceNotification);
    },
    requestResourceSnapshot: async (request, signal) => {
      if (disposed) {
        throw new Error("The RSGL language server has been disposed.");
      }
      if (!isRsglResourceSnapshotRequest(request)) {
        throw new TypeError("The RSGL resource snapshot request failed its runtime guard.");
      }
      if (signal?.aborted) {
        throw abortSignalError(signal, "The RSGL resource snapshot request was cancelled.");
      }
      const cancellation = new vscode.CancellationTokenSource();
      const abort = (): void => cancellation.cancel();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        return await client.sendRequest(
          rsglResourceSnapshotRequest,
          withNativePathMappings(request),
          cancellation.token
        );
      } finally {
        signal?.removeEventListener("abort", abort);
        cancellation.dispose();
      }
    },
    onResourceSnapshotInvalidated: listener => {
      if (disposed) {
        throw new Error("The RSGL language server has been disposed.");
      }
      resourceSnapshotInvalidationListeners.add(listener);
      let listenerDisposed = false;
      return {
        dispose: () => {
          if (listenerDisposed) {
            return;
          }
          listenerDisposed = true;
          resourceSnapshotInvalidationListeners.delete(listener);
        }
      };
    },
    dispose: () => disposePromise ??= (async () => {
      disposed = true;
      resourceSnapshotInvalidationListeners.clear();
      semanticTokenReplayCache.invalidateAll();
      disposeHostDisposables(hostDisposables);
      rsglWorkspaceSourceRootCache.invalidateAll();
      await client.stop();
    })()
  };
}

interface RsglResourceSnapshotTransportRequest extends RsglResourceSnapshotRequest {
  /** Host-derived, process-local mapping; never persisted in ProjectContext. */
  nativePathMappings?: Array<{ uriRoot: string; fileSystemPath: string }>;
}

function withNativePathMappings(
  request: RsglResourceSnapshotRequest
): RsglResourceSnapshotTransportRequest {
  const context = request.projectContext;
  const uris = [
    context.workspaceFolderUri,
    context.projectRootUri,
    context.packRootUri,
    context.assetsRootUri,
    ...context.rsglSourceRootUris,
    context.outputPackRootUri,
    context.outputAssetsRootUri,
    context.localLayer.rootUri,
    ...context.externalLayers
      .filter(layer => layer.source === "directory")
      .map(layer => layer.rootUri),
    ...(context.vanillaLayer?.source === "directory" ? [context.vanillaLayer.rootUri] : [])
  ];
  const mappings = new Map<string, { uriRoot: string; fileSystemPath: string }>();
  for (const uri of uris) {
    try {
      const parsed = vscode.Uri.parse(uri, true);
      if (parsed.scheme === "vscode-remote" && parsed.fsPath.length > 0) {
        mappings.set(parsed.toString(), {
          uriRoot: parsed.toString(),
          fileSystemPath: parsed.fsPath
        });
      }
    } catch {
      // The shared request guard owns URI validation; ignore an unmappable root here.
    }
  }
  return mappings.size > 0
    ? { ...request, nativePathMappings: [...mappings.values()] }
    : request;
}

function cancelledResourceNavigationResponse(
  request: RsglResourceNavigationRequest
): RsglResourceNavigationResponse {
  return {
    protocolVersion: rsglResourceNavigationProtocolVersion,
    requestGeneration: request.requestGeneration,
    operation: request.operation,
    status: "cancelled",
    coverage: "unavailable",
    locations: [],
    reason: "cancelled"
  };
}

function unavailableResourceNavigationResponse(
  request: RsglResourceNavigationRequest
): RsglResourceNavigationResponse {
  return {
    protocolVersion: rsglResourceNavigationProtocolVersion,
    requestGeneration: request.requestGeneration,
    operation: request.operation,
    status: "unavailable",
    coverage: "unavailable",
    locations: [],
    reason: "internalError"
  };
}

/** Validates the custom server payload before it reaches filesystem watchers. */
export function dependencyPathsFromNotification(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const paths = (value as { paths?: unknown }).paths;
  return Array.isArray(paths)
    ? paths.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

/** Reads the server's per-document ownership-aware exact watcher union. */
export function requiredExactWatchPathsFromNotification(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const paths = (value as { requiredExactWatchPaths?: unknown }).requiredExactWatchPaths;
  return Array.isArray(paths)
    ? paths.filter((item): item is string => typeof item === "string" && item.length > 0)
    : dependencyPathsFromNotification(value);
}

/** Validates targeted glob watcher selectors from the language server. */
export function dependencyPatternsFromNotification(value: unknown): RsglDependencyWatchPattern[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const patterns = (value as { patterns?: unknown }).patterns;
  return Array.isArray(patterns)
    ? patterns.filter(isValidDependencyWatchPattern)
    : [];
}

function currentRsglValidationSettings(stdlibRoot: string): RsglValidationSettings {
  return {
    stdlibRoot,
    defaultAssetsPath: configuredDefaultAssetsPath(),
    resourcePackRoots: configuredResourcePackLoadOrder(),
    formatting: configuredRsglFormatting(),
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({
      workspaceFolderUri: folder.uri.toString(),
      workspaceFolderPath: folder.uri.fsPath,
      defaultAssetsPath: configuredDefaultAssetsPath(folder.uri),
      resourcePackRoots: configuredResourcePackLoadOrder(folder.uri),
      formatting: configuredRsglFormatting(folder.uri)
    }))
  };
}

function disposeHostDisposables(disposables: vscode.Disposable[]): void {
  for (const disposable of disposables.splice(0).reverse()) {
    disposable.dispose();
  }
}

function isExistingDirectory(fileName: string): boolean {
  try {
    return fs.statSync(fileName).isDirectory();
  } catch {
    return false;
  }
}

function invalidatesRsglSemanticTokens(fileName: string): boolean {
  return path.extname(fileName).toLowerCase() === ".rsgl"
    || path.basename(fileName).toLowerCase() === "rsgl.config.json";
}

function structuralWatchPattern(selector: DependencyStructureWatchSelector) {
  return selector.kind === "ancestor"
    ? vscodeExactDependencyWatchPattern(selector.path, isExistingDirectory)
    : vscodeGlobDependencyWatchPattern(selector.pattern, isExistingDirectory);
}
