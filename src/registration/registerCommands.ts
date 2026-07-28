import { contributedCommands, internalCommands } from "../commandIds";
import * as vscode from "vscode";
import createCitTemplateCommand from "../cit/commands/createCitTemplate";
import generateCitForCurrentItemCommand from "../cit/commands/generateCitForCurrentItem";
import {
  createMissingCitResource,
  createMissingCitResourceCommand
} from "../cit/providers/citCodeActionProvider";
import createNewResourcePack from "../commands/createNewResourcePack";
import createNewResourcePackRoot from "../commands/createNewResourcePackRoot";
import openDefaultMcAssetsPath from "../commands/openDefaultMcAssetsPath";
import type { ModelPreviewCommandRuntime } from "../modelPreview/commands/modelPreviewCommandRuntime";
import { triggerResourceCompletionCommand } from "../providers/resourceCompletionProvider";
import { workspaceResourceCache } from "../services/workspaceResourceCache";

export function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(contributedCommands.openDefaultMcAssetsPath, openDefaultMcAssetsPath),
    vscode.commands.registerCommand(contributedCommands.createNewResourcePack, createNewResourcePack),
    vscode.commands.registerCommand(contributedCommands.createNewResourcePackRoot, createNewResourcePackRoot),
    vscode.commands.registerCommand(contributedCommands.createCitTemplate, createCitTemplateCommand),
    vscode.commands.registerCommand(contributedCommands.generateCitForCurrentItem, generateCitForCurrentItemCommand),
    vscode.commands.registerCommand(createMissingCitResourceCommand, createMissingCitResource)
  );

  registerModelPreviewCommands(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      internalCommands.showWorkspaceResourceCacheStats,
      () => vscode.window.showInformationMessage(JSON.stringify(workspaceResourceCache.getStats()))
    ),
    vscode.commands.registerCommand(triggerResourceCompletionCommand, () => {
      setTimeout(() => {
        void vscode.commands.executeCommand("editor.action.triggerSuggest");
      }, 0);
    })
  );
}

function registerModelPreviewCommands(context: vscode.ExtensionContext): void {
  let runtimePromise: Promise<ModelPreviewCommandRuntime> | undefined;
  const runtime = () => runtimePromise ??= import("../modelPreview/commands/modelPreviewCommandRuntime.js")
    .then(module => module.createModelPreviewCommandRuntime(context.extensionUri));

  context.subscriptions.push(
    vscode.commands.registerCommand(
      contributedCommands.openModelPreview,
      async (...args: Parameters<ModelPreviewCommandRuntime["open"]>) => (await runtime()).open(...args)
    ),
    vscode.commands.registerCommand(
      contributedCommands.openResourceGraphModelPreview,
      async (...args: Parameters<ModelPreviewCommandRuntime["openGraphNode"]>) =>
        (await runtime()).openGraphNode(...args)
    ),
    vscode.commands.registerCommand(
      contributedCommands.openUnsupportedModelPreviewResource,
      () => vscode.window.showInformationMessage(
        vscode.l10n.t("Model preview supports model JSON resources only for now")
      )
    ),
    vscode.commands.registerCommand(
      contributedCommands.exportModelPreviewImage,
      async (...args: Parameters<ModelPreviewCommandRuntime["exportImage"]>) =>
        (await runtime()).exportImage(...args)
    ),
    vscode.commands.registerCommand(
      internalCommands.captureModelPreviewImage,
      async (...args: Parameters<ModelPreviewCommandRuntime["captureImage"]>) =>
        (await runtime()).captureImage(...args)
    )
  );
}
