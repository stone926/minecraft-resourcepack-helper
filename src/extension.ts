import * as vscode from 'vscode';
import completionProvider from './providers/completionProvider';
import citDefinitionProvider from './providers/citDefinitionProvider';
// import pictureHoverProvider from './providers/pictureHoverProvider';
import textureVarDefinitionProvider from './providers/textureVarDefinitionProvider';
import openDefaultMcAssetsPath from './commands/openDefaultMcAssetsPath';
import createNewResourcePack from './commands/createNewResourcePack';
import createNewResourcePackRoot from './commands/createNewResourcePackRoot';
import { applyDecoration, updateDecoration } from './decorator/textureVarDecorator';
import blockstateDefinitionProvider from './providers/blockstateDefinitionProvider';
import blockModelDefinitionProvider from './providers/blockModelDefinitionProvider';
import itemModelDefinitionProvider from './providers/itemModelDefinitionProvider';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    [{ language: "json", pattern: "**/blockstates/*.json" }],
    { provideDefinition: blockstateDefinitionProvider }
  ));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    [{ language: "json", pattern: "**/models/block/**/*.json" }],
    { provideDefinition: blockModelDefinitionProvider }
  ));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    [{ language: "json", pattern: "**/models/item/**/*.json" }],
    { provideDefinition: itemModelDefinitionProvider }
  ));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    [{ language: "json", pattern: "**/models/block/**/*.json" }],
    { provideDefinition: textureVarDefinitionProvider, }
  ));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider('properties', {
    provideDefinition: citDefinitionProvider
  }));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(['json', 'javascript'], {
    provideCompletionItems: completionProvider,
  }, ...['"', '/']));

  // context.subscriptions.push(vscode.languages.registerHoverProvider(
  //   [{ language: "json", pattern: "**/models/block/**/*.json" },
  //   { language: "json", pattern: "**/models/item/**/*.json" }],
  //   { provideHover: pictureHoverProvider }
  // ));

  context.subscriptions.push(vscode.commands.registerCommand('McResHelper.openDefaultMcAssetsPath', openDefaultMcAssetsPath));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.createNewResourcePack", createNewResourcePack));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.createNewResourcePackRoot", createNewResourcePackRoot));

  let activeEditor: vscode.TextEditor;

  if (vscode.window.activeTextEditor) {
    activeEditor = vscode.window.activeTextEditor;
    applyDecoration(activeEditor);
  }

  // * Handle active file changed
  vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      activeEditor = editor;
      applyDecoration(activeEditor);
    }
  }, null, context.subscriptions);

  // * Handle file contents changed
  vscode.workspace.onDidChangeTextDocument(event => {
    if (activeEditor && event.document === activeEditor.document) {
      applyDecoration(activeEditor);
    }
  }, null, context.subscriptions);

  vscode.workspace.onDidChangeConfiguration(event => {
    if (activeEditor) {
      updateDecoration(activeEditor);
    }
  });
}

export function deactivate() { }
