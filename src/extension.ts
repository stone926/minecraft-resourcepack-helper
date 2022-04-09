import * as vscode from 'vscode';
import definitionProvider from './providers/definitionProvider';
import completionProvider from './providers/completionProvider';
import citDefinitionProvider from './providers/citDefinitionProvider';
import renameProvider from './providers/renameProvider';

export function activate(context: vscode.ExtensionContext) {

  context.subscriptions.push(vscode.languages.registerDefinitionProvider('json', {
    provideDefinition: definitionProvider,
  }));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider('properties', {
    provideDefinition: citDefinitionProvider
  }));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(['json', 'javascript'], {
    provideCompletionItems: completionProvider,
  }, ...['"', '/']));

  // context.subscriptions.push(vscode.languages.registerRenameProvider('json', {
  // 	provideRenameEdits: renameProvider,
  // }))
}

export function deactivate() { }
