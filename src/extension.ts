import * as vscode from 'vscode';
// import completionProvider from './providers/completionProvider';
import citDefinitionProvider from './providers/citDefinitionProvider';
// import pictureHoverProvider from './providers/pictureHoverProvider';
import textureVarDefinitionProvider from './providers/textureVarDefinitionProvider';
import openDefaultMcAssetsPath from './commands/openDefaultMcAssetsPath';
import createNewResourcePack from './commands/createNewResourcePack';
import createNewResourcePackRoot from './commands/createNewResourcePackRoot';
import { applyDecoration, disposeDecoration, updateDecoration } from './decorator/textureVarDecorator';
import resourceDefinitionProvider from './providers/resourceDefinitionProvider';
import resourceCompletionProvider from './providers/resourceCompletionProvider';
import { refreshResourceDiagnostics } from './diagnostics/resourceDiagnostics';
import { ResourceGraphTreeProvider } from './views/resourceGraphTree';

const resourceReferenceSelectors: vscode.DocumentSelector = [
  { language: "json", pattern: "**/blockstates/*.json" },
  { language: "json", pattern: "**/models/block/**/*.json" },
  { language: "json", pattern: "**/models/item/**/*.json" },
  { language: "json", pattern: "**/particles/**/*.json" },
  { language: "json", pattern: "**/items/**/*.json" },
  { language: "json", pattern: "**/atlases/**/*.json" },
  { language: "json", pattern: "**/equipment/**/*.json" },
  { language: "json", pattern: "**/font/**/*.json" },
  { language: "json", pattern: "**/waypoint_style/**/*.json" },
  { language: "json", pattern: "**/post_effect/**/*.json" }
];

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    resourceReferenceSelectors,
    { provideDefinition: resourceDefinitionProvider }
  ));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    [
      { language: "json", pattern: "**/models/block/**/*.json" },
      { language: "json", pattern: "**/models/item/**/*.json" }
    ],
    { provideDefinition: textureVarDefinitionProvider }
  ));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    resourceReferenceSelectors,
    resourceCompletionProvider,
    '"',
    '/',
    ':'
  ));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider('properties', {
    provideDefinition: citDefinitionProvider
  }));

  // context.subscriptions.push(vscode.languages.registerCompletionItemProvider(['json', 'javascript'], {
  //   provideCompletionItems: completionProvider,
  // }, ...['"', '/']));

  // context.subscriptions.push(vscode.languages.registerHoverProvider(
  //   [{ language: "json", pattern: "**/models/block/**/*.json" },
  //   { language: "json", pattern: "**/models/item/**/*.json" }],
  //   { provideHover: pictureHoverProvider }
  // ));

  context.subscriptions.push(vscode.commands.registerCommand('McResHelper.openDefaultMcAssetsPath', openDefaultMcAssetsPath));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.createNewResourcePack", createNewResourcePack));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.createNewResourcePackRoot", createNewResourcePackRoot));

  const resourceGraphTreeProvider = new ResourceGraphTreeProvider();
  context.subscriptions.push(vscode.window.createTreeView("McResHelper.resourceGraph", {
    treeDataProvider: resourceGraphTreeProvider,
    showCollapseAll: true
  }));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.refreshResourceGraph", () => {
    resourceGraphTreeProvider.refresh();
  }));

  const resourceDiagnostics = vscode.languages.createDiagnosticCollection("McResHelper resources");
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
    resourceGraphTreeProvider.refresh();
  }, null, context.subscriptions);

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
    if (event.affectsConfiguration("McResHelper.defaultMcAssetsPath")) {
      for (const document of vscode.workspace.textDocuments) {
        refreshResourceDiagnostics(document, resourceDiagnostics);
      }
      resourceGraphTreeProvider.refresh();
    }
  }));

  context.subscriptions.push({ dispose: disposeDecoration });
}

export function deactivate() { }
