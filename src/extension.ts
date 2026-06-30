import * as vscode from 'vscode';
import citDefinitionProvider from './providers/citDefinitionProvider';
import textureVarDefinitionProvider from './providers/textureVarDefinitionProvider';
import openDefaultMcAssetsPath from './commands/openDefaultMcAssetsPath';
import createNewResourcePack from './commands/createNewResourcePack';
import createNewResourcePackRoot from './commands/createNewResourcePackRoot';
import { applyDecoration, disposeDecoration, updateDecoration } from './decorator/textureVarDecorator';
import resourceDefinitionProvider from './providers/resourceDefinitionProvider';
import resourceCompletionProvider from './providers/resourceCompletionProvider';
import { refreshResourceDiagnostics } from './diagnostics/resourceDiagnostics';
import { getResourceGraphNodeUri, ResourceGraphTreeProvider } from './views/resourceGraphTree';
import { isResourceGraphDocumentPath } from './utils/resourceGraph';
import { ModelPreviewService } from './modelPreview/service/ModelPreviewService';
import { ModelPreviewHostFileSystem } from './modelPreview/host/ModelPreviewHostFileSystem';
import { openModelPreviewCommand } from './modelPreview/commands/openModelPreview';
import { captureModelPreviewImageCommand, exportModelPreviewImageCommand } from './modelPreview/commands/exportModelPreviewImage';

const jsonResourceReferenceSelectors: vscode.DocumentSelector = [
  { language: "json", pattern: "**/blockstates/*.json" },
  { language: "json", pattern: "**/models/**/*.json" },
  { language: "json", pattern: "**/particles/**/*.json" },
  { language: "json", pattern: "**/items/**/*.json" },
  { language: "json", pattern: "**/atlases/**/*.json" },
  { language: "json", pattern: "**/equipment/**/*.json" },
  { language: "json", pattern: "**/font/**/*.json" },
  { language: "json", pattern: "**/waypoint_style/**/*.json" },
  { language: "json", pattern: "**/post_effect/**/*.json" },
  { language: "json", pattern: "**/assets/*/sounds.json" }
];

const shaderResourceReferenceSelectors: vscode.DocumentSelector = [
  { pattern: "**/assets/*/shaders/core/**/*.vsh" },
  { pattern: "**/assets/*/shaders/core/**/*.fsh" },
  { pattern: "**/assets/*/shaders/post/**/*.vsh" },
  { pattern: "**/assets/*/shaders/post/**/*.fsh" }
];

const resourceReferenceSelectors: vscode.DocumentSelector = [
  ...jsonResourceReferenceSelectors,
  ...shaderResourceReferenceSelectors
];

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    resourceReferenceSelectors,
    { provideDefinition: resourceDefinitionProvider }
  ));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    [
      { language: "json", pattern: "**/models/**/*.json" }
    ],
    { provideDefinition: textureVarDefinitionProvider }
  ));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    resourceReferenceSelectors,
    resourceCompletionProvider,
    '"',
    '<',
    '/',
    ':'
  ));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider('properties', {
    provideDefinition: citDefinitionProvider
  }));

  context.subscriptions.push(vscode.commands.registerCommand('McResHelper.openDefaultMcAssetsPath', openDefaultMcAssetsPath));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.createNewResourcePack", createNewResourcePack));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.createNewResourcePackRoot", createNewResourcePackRoot));

  const modelPreviewService = new ModelPreviewService({
    fileSystem: new ModelPreviewHostFileSystem(),
    configuration: () => ({
      defaultAssetsPath: vscode.workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath"),
      resourcePackRoots: vscode.workspace.getConfiguration().get<string[]>("McResHelper.resourcePackLoadOrder") ?? []
    })
  });
  const openModelPreview = openModelPreviewCommand(context.extensionUri, modelPreviewService);
  context.subscriptions.push(vscode.commands.registerCommand(
    "McResHelper.openModelPreview",
    openModelPreview
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "McResHelper.openResourceGraphModelPreview",
    (node?: unknown) => {
      const uri = getResourceGraphNodeUri(node);
      return openModelPreview(uri ?? undefined);
    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "McResHelper.openUnsupportedModelPreviewResource",
    () => vscode.window.showInformationMessage(vscode.l10n.t("Model preview supports model JSON resources only for now"))
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "McResHelper.exportModelPreviewImage",
    exportModelPreviewImageCommand(context.extensionUri, modelPreviewService)
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "McResHelper.captureModelPreviewImage",
    captureModelPreviewImageCommand(context.extensionUri, modelPreviewService)
  ));

  const resourceGraphTreeProvider = new ResourceGraphTreeProvider();
  context.subscriptions.push(resourceGraphTreeProvider);
  context.subscriptions.push(vscode.window.createTreeView("McResHelper.resourceGraph", {
    treeDataProvider: resourceGraphTreeProvider,
    showCollapseAll: true
  }));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.refreshResourceGraph", () => {
    resourceGraphTreeProvider.refresh();
  }));

  const resourceDiagnostics = vscode.languages.createDiagnosticCollection(vscode.l10n.t("McResHelper resources"));
  context.subscriptions.push(resourceDiagnostics);
  for (const document of vscode.workspace.textDocuments) {
    refreshResourceDiagnostics(document, resourceDiagnostics);
  }

  let activeEditor: vscode.TextEditor | undefined;

  if (vscode.window.activeTextEditor) {
    activeEditor = vscode.window.activeTextEditor;
    applyDecoration(activeEditor);
  }

  // * Handle active file changed
  vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      activeEditor = editor;
      applyDecoration(activeEditor);
      resourceGraphTreeProvider.refresh();
    } else {
      activeEditor = undefined;
      resourceGraphTreeProvider.refresh();
    }
  }, null, context.subscriptions);

  // * Handle file contents changed
  vscode.workspace.onDidChangeTextDocument(event => {
    if (activeEditor && event.document === activeEditor.document) {
      applyDecoration(activeEditor);
    }
    refreshResourceDiagnostics(event.document, resourceDiagnostics);
    if (isResourceGraphDocumentPath(event.document.fileName)) {
      resourceGraphTreeProvider.refreshSoon();
    }
  }, null, context.subscriptions);

  const resourceJsonWatcher = vscode.workspace.createFileSystemWatcher("**/assets/**/*.json");
  context.subscriptions.push(resourceJsonWatcher);
  resourceJsonWatcher.onDidCreate(() => resourceGraphTreeProvider.refreshSoon(), null, context.subscriptions);
  resourceJsonWatcher.onDidChange(() => resourceGraphTreeProvider.refreshSoon(), null, context.subscriptions);
  resourceJsonWatcher.onDidDelete(() => resourceGraphTreeProvider.refreshSoon(), null, context.subscriptions);

  const shaderWatchers = [
    vscode.workspace.createFileSystemWatcher("**/assets/*/shaders/**/*.vsh"),
    vscode.workspace.createFileSystemWatcher("**/assets/*/shaders/**/*.fsh"),
    vscode.workspace.createFileSystemWatcher("**/assets/*/shaders/**/*.glsl")
  ];
  context.subscriptions.push(...shaderWatchers);
  for (const shaderWatcher of shaderWatchers) {
    shaderWatcher.onDidCreate(() => resourceGraphTreeProvider.refreshSoon(), null, context.subscriptions);
    shaderWatcher.onDidChange(() => resourceGraphTreeProvider.refreshSoon(), null, context.subscriptions);
    shaderWatcher.onDidDelete(() => resourceGraphTreeProvider.refreshSoon(), null, context.subscriptions);
  }

  vscode.workspace.onDidOpenTextDocument(document => {
    refreshResourceDiagnostics(document, resourceDiagnostics);
  }, null, context.subscriptions);

  vscode.workspace.onDidCloseTextDocument(document => {
    resourceDiagnostics.delete(document.uri);
  }, null, context.subscriptions);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("McResHelper.tipColorForUndefinedTextureVariables") && activeEditor) {
      updateDecoration(activeEditor);
    }
    if (
      event.affectsConfiguration("McResHelper.defaultMcAssetsPath") ||
      event.affectsConfiguration("McResHelper.resourcePackLoadOrder")
    ) {
      for (const document of vscode.workspace.textDocuments) {
        refreshResourceDiagnostics(document, resourceDiagnostics);
      }
      resourceGraphTreeProvider.refresh();
    }
  }));

  context.subscriptions.push({ dispose: disposeDecoration });
}

export function deactivate() { }
