import * as vscode from 'vscode';
import definitionProvider from './providers/definitionProvider';
import completionProvider from './providers/completionProvider';
import citDefinitionProvider from './providers/citDefinitionProvider';
import pictureHoverProvider from './providers/pictureHoverProvider';
import textureVarDefinitionProvider from './providers/textureVarDefinitionProvider';
import applyDecoration from './decorator/textureVarDecorator';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.languages.registerDefinitionProvider('json', {
    provideDefinition: definitionProvider,
  }));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider('json', {
    provideDefinition: textureVarDefinitionProvider,
  }));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider('properties', {
    provideDefinition: citDefinitionProvider
  }));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(['json', 'javascript'], {
    provideCompletionItems: completionProvider,
  }, ...['"', '/']));

  context.subscriptions.push(vscode.languages.registerHoverProvider("json", {
    provideHover: pictureHoverProvider
  }));

  context.subscriptions.push(vscode.commands.registerCommand('McAssetsHelper.openDefaultMcAssetsPath', () => {
    const defaultPath = vscode.workspace.getConfiguration().get("McResHelper.defaultMcAssetsPath");
    if (defaultPath !== null) {
      vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(<string>defaultPath), {
        "forceNewWindow": true
      });
    }
  }));

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

}

export function deactivate() { }
