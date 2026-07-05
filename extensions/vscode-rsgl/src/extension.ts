import * as vscode from "vscode";
import { registerRsglLanguageFeatures } from "./languageFeatures";
import { createRsglApi, type RsglApi } from "./api";
import {
  buildActiveRsglResourcePack,
  buildActiveRsglResourcePackDirectory,
  buildRsglResourcePackCommand,
  buildRsglResourcePackDirectoryCommand,
  buildRsglWorkspaceResourcePacks,
  buildRsglWorkspaceResourcePacksCommand,
  previewActiveRsglResourcePackBuild,
  previewActiveRsglResourcePackDirectoryBuild,
  previewRsglResourcePackBuildCommand,
  previewRsglResourcePackDirectoryBuildCommand,
  previewRsglWorkspaceResourcePackBuilds,
  previewRsglWorkspaceResourcePackBuildsCommand
} from "./commands/build";

export function activate(context: vscode.ExtensionContext): RsglApi {
  registerRsglLanguageFeatures(context);
  registerRsglCommands(context);
  return createRsglApi(context);
}

export function deactivate(): void { }

function registerRsglCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(buildRsglResourcePackCommand, buildActiveRsglResourcePack));
  context.subscriptions.push(vscode.commands.registerCommand(previewRsglResourcePackBuildCommand, previewActiveRsglResourcePackBuild));
  context.subscriptions.push(vscode.commands.registerCommand(buildRsglResourcePackDirectoryCommand, buildActiveRsglResourcePackDirectory));
  context.subscriptions.push(vscode.commands.registerCommand(previewRsglResourcePackDirectoryBuildCommand, previewActiveRsglResourcePackDirectoryBuild));
  context.subscriptions.push(vscode.commands.registerCommand(buildRsglWorkspaceResourcePacksCommand, buildRsglWorkspaceResourcePacks));
  context.subscriptions.push(vscode.commands.registerCommand(previewRsglWorkspaceResourcePackBuildsCommand, previewRsglWorkspaceResourcePackBuilds));
}
