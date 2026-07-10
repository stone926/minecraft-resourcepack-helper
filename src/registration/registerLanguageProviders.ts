import * as vscode from "vscode";
import citCodeActionProvider from "../cit/providers/citCodeActionProvider";
import citCompletionProvider from "../cit/providers/citCompletionProvider";
import citHoverProvider from "../cit/providers/citHoverProvider";
import resourceCompletionProvider from "../providers/resourceCompletionProvider";
import resourceDefinitionProvider from "../providers/resourceDefinitionProvider";
import textureVarDefinitionProvider from "../providers/textureVarDefinitionProvider";
import { getResourceDocumentSelectors } from "../resources/resourceSurfaceRegistry";

const resourceReferenceSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("references");
const textureVariableSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("textureVariables");
const citLanguageSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("citLanguage");
const citCodeActionSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("citCodeAction");

export function registerLanguageProviders(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    resourceReferenceSelectors,
    { provideDefinition: resourceDefinitionProvider }
  ));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    textureVariableSelectors,
    { provideDefinition: textureVarDefinitionProvider }
  ));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    resourceReferenceSelectors,
    resourceCompletionProvider,
    "\"",
    "<",
    "/",
    ":",
    "="
  ));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    citLanguageSelectors,
    citCompletionProvider,
    "=",
    "."
  ));

  context.subscriptions.push(vscode.languages.registerHoverProvider(
    citLanguageSelectors,
    citHoverProvider
  ));

  context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
    citCodeActionSelectors,
    citCodeActionProvider,
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  ));
}
