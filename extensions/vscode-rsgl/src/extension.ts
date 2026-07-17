import * as vscode from "vscode";
import { rsglCommands } from "../../../packages/rsgl-shared/src";

type RsglBuildCommands = typeof import("./commands/build.js");
type RsglClient = typeof import("./client.js");

export function activate(context: vscode.ExtensionContext): void {
  const clientPromise: Promise<ReturnType<RsglClient["startRsglLanguageServer"]>> = import("./client.js")
    .then(module => module.startRsglLanguageServer(context))
    .catch(error => {
      console.error(error);
      void vscode.window.showErrorMessage(vscode.l10n.t("RSGL language server not found. Reinstall the RSGL extension."));
      return null;
    });
  registerRsglCommands(context, clientPromise);
}

export function deactivate(): void { }

function registerRsglCommands(
  context: vscode.ExtensionContext,
  clientPromise: Promise<ReturnType<RsglClient["startRsglLanguageServer"]>>
): void {
  let buildCommandsPromise: Promise<RsglBuildCommands> | undefined;
  const buildCommands = () => buildCommandsPromise ??= import("./commands/build.js");
  context.subscriptions.push(
    vscode.commands.registerCommand(rsglCommands.build, async (uri?: vscode.Uri) =>
      (await buildCommands()).buildActiveRsglResourcePack(uri)),
    vscode.commands.registerCommand(rsglCommands.previewBuild, async (uri?: vscode.Uri) =>
      (await buildCommands()).previewActiveRsglResourcePackBuild(uri)),
    vscode.commands.registerCommand(rsglCommands.buildDirectory, async (uri?: vscode.Uri) =>
      (await buildCommands()).buildActiveRsglResourcePackDirectory(uri)),
    vscode.commands.registerCommand(rsglCommands.previewDirectoryBuild, async (uri?: vscode.Uri) =>
      (await buildCommands()).previewActiveRsglResourcePackDirectoryBuild(uri)),
    vscode.commands.registerCommand(rsglCommands.buildWorkspace, async () =>
      (await buildCommands()).buildRsglWorkspaceResourcePacks()),
    vscode.commands.registerCommand(rsglCommands.previewWorkspaceBuild, async () =>
      (await buildCommands()).previewRsglWorkspaceResourcePackBuilds()),
    vscode.commands.registerCommand(rsglCommands.refreshWorkspace, async () =>
      (await clientPromise)?.refreshWorkspace())
  );
}
