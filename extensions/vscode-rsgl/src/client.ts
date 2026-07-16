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
  rsglFileGlob,
  type RsglDependencyPathsNotification
} from "../../../packages/rsgl-shared/src";
import { rsglWorkspaceSourceRootCache } from "../../../packages/rsgl-core/src/sourceRoot";
import { configuredDefaultAssetsPath, configuredResourcePackLoadOrder } from "./configuration";
import { DependencyWatchRegistry, requiresExactDependencyWatcher } from "./dependencyWatch";

interface RsglValidationSettings {
  defaultAssetsPath: string | null;
  resourcePackRoots: string[];
}

export function startRsglLanguageServer(context: vscode.ExtensionContext): void {
  const serverModule = context.asAbsolutePath(path.join("out", "packages", "rsgl-lsp", "src", "server.js"));
  if (!fs.existsSync(serverModule)) {
    void vscode.window.showErrorMessage(vscode.l10n.t("RSGL language server not found. Reinstall the RSGL extension."));
    return;
  }

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc }
  };
  const rsglWatcher = vscode.workspace.createFileSystemWatcher(rsglFileGlob);
  const jsonWatcher = vscode.workspace.createFileSystemWatcher("**/*.json");
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "rsgl" }],
    initializationOptions: () => currentRsglValidationSettings(),
    synchronize: {
      fileEvents: [
        rsglWatcher,
        jsonWatcher
      ]
    }
  };
  const client = new LanguageClient("rsgl", "RSGL", serverOptions, clientOptions);
  context.subscriptions.push(
    rsglWatcher,
    jsonWatcher,
    rsglWatcher.onDidCreate(uri => rsglWorkspaceSourceRootCache.invalidatePath(uri.fsPath)),
    rsglWatcher.onDidDelete(uri => rsglWorkspaceSourceRootCache.invalidatePath(uri.fsPath)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => rsglWorkspaceSourceRootCache.invalidateAll())
  );
  const sendDependencyChange = (uri: vscode.Uri, type: FileChangeType) => {
    void client.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: uri.toString(), type }]
    });
  };
  const externalDependencyWatchers = new DependencyWatchRegistry(fileName => {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
      vscode.Uri.file(path.dirname(fileName)),
      path.basename(fileName)
    ));
    watcher.onDidCreate(uri => sendDependencyChange(uri, FileChangeType.Created));
    watcher.onDidChange(uri => sendDependencyChange(uri, FileChangeType.Changed));
    watcher.onDidDelete(uri => sendDependencyChange(uri, FileChangeType.Deleted));
    return watcher;
  });
  const dependencyNotification = client.onNotification(
    rsglDependencyPathsNotification,
    (notification: RsglDependencyPathsNotification) => {
      const exactPaths = dependencyPathsFromNotification(notification)
        .filter(fileName => requiresExactDependencyWatcher(
          fileName,
          Boolean(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fileName)))
        ));
      const update = externalDependencyWatchers.update(exactPaths);
      if (update.added.length > 0) {
        void client.sendNotification(DidChangeWatchedFilesNotification.type, {
          changes: update.added.map(fileName => ({
            uri: vscode.Uri.file(fileName).toString(),
            type: FileChangeType.Changed
          }))
        });
      }
    }
  );
  void client.start();
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
    { dispose: () => void client.stop() }
  );
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

function currentRsglValidationSettings(): RsglValidationSettings {
  return {
    defaultAssetsPath: configuredDefaultAssetsPath(),
    resourcePackRoots: configuredResourcePackLoadOrder()
  };
}
