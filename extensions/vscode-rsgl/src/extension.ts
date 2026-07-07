import * as vscode from "vscode";
import { rsglCommands } from "../../../packages/rsgl-shared/src";
import { registerRsglLanguageFeatures } from "./languageFeatures";
import { createRsglApi, type RsglApi } from "./api";
import {
  buildActiveRsglResourcePack,
  buildActiveRsglResourcePackDirectory,
  buildRsglWorkspaceResourcePacks,
  previewActiveRsglResourcePackBuild,
  previewActiveRsglResourcePackDirectoryBuild,
  previewRsglWorkspaceResourcePackBuilds
} from "./commands/build";

export function activate(context: vscode.ExtensionContext): RsglApi {
  registerRsglLanguageFeatures(context);
  registerRsglCommands(context);
  return createRsglApi(context);
}

export function deactivate(): void { }

function registerRsglCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(rsglCommands.build, buildActiveRsglResourcePack));
  context.subscriptions.push(vscode.commands.registerCommand(rsglCommands.previewBuild, previewActiveRsglResourcePackBuild));
  context.subscriptions.push(vscode.commands.registerCommand(rsglCommands.buildDirectory, buildActiveRsglResourcePackDirectory));
  context.subscriptions.push(vscode.commands.registerCommand(rsglCommands.previewDirectoryBuild, previewActiveRsglResourcePackDirectoryBuild));
  context.subscriptions.push(vscode.commands.registerCommand(rsglCommands.buildWorkspace, buildRsglWorkspaceResourcePacks));
  context.subscriptions.push(vscode.commands.registerCommand(rsglCommands.previewWorkspaceBuild, previewRsglWorkspaceResourcePackBuilds));
}
