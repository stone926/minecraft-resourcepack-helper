import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";

export function startRsglLanguageServer(context: vscode.ExtensionContext): boolean {
  const serverModule = context.asAbsolutePath(path.join("out", "packages", "rsgl-lsp", "src", "server.js"));
  if (!fs.existsSync(serverModule)) {
    return false;
  }

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc }
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "rsgl" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.rsgl")
    }
  };
  const client = new LanguageClient("rsgl", "RSGL", serverOptions, clientOptions);
  void client.start();
  context.subscriptions.push({ dispose: () => void client.stop() });
  return true;
}
