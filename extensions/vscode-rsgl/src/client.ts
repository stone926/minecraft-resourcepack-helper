import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions
} from "vscode-languageclient/node";
import {
  rsglDependencyPathsNotification,
  rsglDependencyStructureChangedNotification,
  rsglFileGlob,
  rsglRefreshWorkspaceNotification,
  type RsglDependencyPathsNotification,
  type RsglDependencyWatchPattern
} from "../../../packages/rsgl-shared/src";
import { rsglWorkspaceSourceRootCache } from "../../../packages/rsgl-core/src/sourceRoot";
import { configuredDefaultAssetsPath, configuredResourcePackLoadOrder } from "./configuration";
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

interface RsglValidationSettings {
  defaultAssetsPath: string | null;
  resourcePackRoots: string[];
}

export interface RsglLanguageServerController {
  refreshWorkspace(): Promise<void>;
}

export function startRsglLanguageServer(context: vscode.ExtensionContext): RsglLanguageServerController | null {
  const serverModule = context.asAbsolutePath(path.join("bundle", "server.js"));
  if (!fs.existsSync(serverModule)) {
    void vscode.window.showErrorMessage(vscode.l10n.t("RSGL language server not found. Reinstall the RSGL extension."));
    return null;
  }

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc }
  };
  const rsglWatcher = vscode.workspace.createFileSystemWatcher(rsglFileGlob);
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "rsgl" }],
    initializationOptions: () => currentRsglValidationSettings(),
    synchronize: {
      fileEvents: [rsglWatcher]
    }
  };
  const client = new LanguageClient("rsgl", "RSGL", serverOptions, clientOptions);
  context.subscriptions.push(
    rsglWatcher,
    rsglWatcher.onDidCreate(uri => rsglWorkspaceSourceRootCache.invalidatePath(uri.fsPath)),
    rsglWatcher.onDidDelete(uri => rsglWorkspaceSourceRootCache.invalidatePath(uri.fsPath)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => rsglWorkspaceSourceRootCache.invalidateAll())
  );
  const sendDependencyChange = (uri: vscode.Uri, type: FileChangeType) => {
    void client.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: uri.toString(), type }]
    });
  };
  const sendDependencyStructureChange = (uri: vscode.Uri) => {
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
        void client.sendNotification(DidChangeWatchedFilesNotification.type, {
          changes: addedDependencyPaths.map(fileName => ({
            uri: vscode.Uri.file(fileName).toString(),
            type: FileChangeType.Changed
          }))
        });
      }
    }
  );
  const startPromise = client.start();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("rsgl")) {
      void client.sendNotification(DidChangeConfigurationNotification.type, {
        settings: currentRsglValidationSettings()
      });
    }
  }));
  context.subscriptions.push(
    dependencyNotification,
    externalDependencyWatchers,
    patternDependencyWatchers,
    structuralDependencyWatchers,
    { dispose: () => void client.stop() }
  );
  return {
    refreshWorkspace: async () => {
      rsglWorkspaceSourceRootCache.invalidateAll();
      await startPromise;
      await client.sendNotification(rsglRefreshWorkspaceNotification);
    }
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

function currentRsglValidationSettings(): RsglValidationSettings {
  return {
    defaultAssetsPath: configuredDefaultAssetsPath(),
    resourcePackRoots: configuredResourcePackLoadOrder()
  };
}

function isExistingDirectory(fileName: string): boolean {
  try {
    return fs.statSync(fileName).isDirectory();
  } catch {
    return false;
  }
}

function structuralWatchPattern(selector: DependencyStructureWatchSelector) {
  return selector.kind === "ancestor"
    ? vscodeExactDependencyWatchPattern(selector.path, isExistingDirectory)
    : vscodeGlobDependencyWatchPattern(selector.pattern, isExistingDirectory);
}
