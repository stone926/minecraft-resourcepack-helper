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
import {
  captureModelPreviewImageCommand,
  exportModelPreviewImageCommand
} from "../modelPreview/commands/exportModelPreviewImage";
import { openModelPreviewCommand } from "../modelPreview/commands/openModelPreview";
import { ModelPreviewHostFileSystem } from "../modelPreview/host/ModelPreviewHostFileSystem";
import { ModelPreviewService } from "../modelPreview/service/ModelPreviewService";
import { triggerResourceCompletionCommand } from "../providers/resourceCompletionProvider";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import { getResourceGraphNodeUri } from "../views/resourceGraphTreeItem";

export function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("McResHelper.openDefaultMcAssetsPath", openDefaultMcAssetsPath),
    vscode.commands.registerCommand("McResHelper.createNewResourcePack", createNewResourcePack),
    vscode.commands.registerCommand("McResHelper.createNewResourcePackRoot", createNewResourcePackRoot),
    vscode.commands.registerCommand("McResHelper.createCitTemplate", createCitTemplateCommand),
    vscode.commands.registerCommand("McResHelper.generateCitForCurrentItem", generateCitForCurrentItemCommand),
    vscode.commands.registerCommand(createMissingCitResourceCommand, createMissingCitResource)
  );

  registerModelPreviewCommands(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "McResHelper.showWorkspaceResourceCacheStats",
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
  const modelPreviewService = new ModelPreviewService({
    fileSystem: new ModelPreviewHostFileSystem(),
    configuration: getResourceConfiguration,
    artifactCache: workspaceResourceCache.modelPreviewArtifacts
  });
  const openModelPreview = openModelPreviewCommand(context.extensionUri, modelPreviewService);

  context.subscriptions.push(
    vscode.commands.registerCommand("McResHelper.openModelPreview", openModelPreview),
    vscode.commands.registerCommand("McResHelper.openResourceGraphModelPreview", (node?: unknown) => {
      const uri = getResourceGraphNodeUri(node);
      return openModelPreview(uri ?? undefined);
    }),
    vscode.commands.registerCommand(
      "McResHelper.openUnsupportedModelPreviewResource",
      () => vscode.window.showInformationMessage(
        vscode.l10n.t("Model preview supports model JSON resources only for now")
      )
    ),
    vscode.commands.registerCommand(
      "McResHelper.exportModelPreviewImage",
      exportModelPreviewImageCommand(context.extensionUri, modelPreviewService)
    ),
    vscode.commands.registerCommand(
      "McResHelper.captureModelPreviewImage",
      captureModelPreviewImageCommand(context.extensionUri, modelPreviewService)
    )
  );
}
