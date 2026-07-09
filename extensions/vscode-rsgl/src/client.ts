import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  DidChangeConfigurationNotification,
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions
} from "vscode-languageclient/node";
import { configuredDefaultAssetsPath, configuredResourcePackLoadOrder } from "./configuration";

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
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "rsgl" }],
    initializationOptions: () => currentRsglValidationSettings(),
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.rsgl")
    }
  };
  const client = new LanguageClient("rsgl", "RSGL", serverOptions, clientOptions);
  void client.start();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("rsgl")) {
      void client.sendNotification(DidChangeConfigurationNotification.type, {
        settings: currentRsglValidationSettings()
      });
    }
  }));
  context.subscriptions.push({ dispose: () => void client.stop() });
}

function currentRsglValidationSettings(): RsglValidationSettings {
  return {
    defaultAssetsPath: configuredDefaultAssetsPath(),
    resourcePackRoots: configuredResourcePackLoadOrder()
  };
}
