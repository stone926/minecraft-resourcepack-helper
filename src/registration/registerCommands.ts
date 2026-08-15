import { contributedCommands, internalCommands } from "../commandIds";
import * as vscode from "vscode";
import createCitTemplateCommand from "../cit/commands/createCitTemplate";
import generateCitForCurrentItemCommand from "../cit/commands/generateCitForCurrentItem";
import type { ModelPreviewCommandRuntime } from "../modelPreview/commands/modelPreviewCommandRuntime";
import { workspaceResourceCache } from "../services/workspaceResourceCache";

export function registerCommands(context: vscode.ExtensionContext): void {
  const openDefaultMcAssetsPath = createLazyCommand<[], void>(() =>
    import("../commands/openDefaultMcAssetsPath.js")
      .then(module => module.openDefaultMcAssetsPath));
  const createNewResourcePack = createLazyCommand<[], Promise<void>>(() =>
    import("../commands/createNewResourcePack.js")
      .then(module => module.createNewResourcePack));
  const createNewResourcePackRoot = createLazyCommand<[], Promise<void>>(() =>
    import("../commands/createNewResourcePackRoot.js")
      .then(module => module.createNewResourcePackRoot));
  const createMissingCitResource = createLazyCommand<
    [uri: vscode.Uri, referenceIndex: number],
    Promise<vscode.Uri | null>
  >(() =>
    import("../cit/commands/createMissingCitResource.js")
      .then(module => module.createMissingCitResource));

  context.subscriptions.push(
    vscode.commands.registerCommand(contributedCommands.openDefaultMcAssetsPath, openDefaultMcAssetsPath),
    vscode.commands.registerCommand(contributedCommands.createNewResourcePack, createNewResourcePack),
    vscode.commands.registerCommand(contributedCommands.createNewResourcePackRoot, createNewResourcePackRoot),
    vscode.commands.registerCommand(contributedCommands.createCitTemplate, createCitTemplateCommand),
    vscode.commands.registerCommand(contributedCommands.generateCitForCurrentItem, generateCitForCurrentItemCommand),
    vscode.commands.registerCommand(internalCommands.createMissingCitResource, createMissingCitResource)
  );

  registerModelPreviewCommands(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      internalCommands.showWorkspaceResourceCacheStats,
      () => vscode.window.showInformationMessage(JSON.stringify(workspaceResourceCache.getStats()))
    ),
    vscode.commands.registerCommand(internalCommands.triggerResourceCompletion, (documentUri?: string) => {
      setTimeout(() => {
        if (
          documentUri
          && vscode.window.activeTextEditor?.document.uri.toString() !== documentUri
        ) {
          return;
        }
        void vscode.commands.executeCommand("editor.action.triggerSuggest");
      }, 0);
    })
  );
}

function createLazyCommand<Args extends unknown[], Result>(
  load: () => Promise<(...args: Args) => Result>
): (...args: Args) => Promise<Awaited<Result>> {
  let commandPromise: Promise<(...args: Args) => Result> | undefined;
  return async (...args: Args): Promise<Awaited<Result>> =>
    await (await (commandPromise ??= load()))(...args);
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
