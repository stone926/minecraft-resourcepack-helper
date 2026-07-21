import * as vscode from "vscode";
import citCodeActionProvider from "../cit/providers/citCodeActionProvider";
import citCompletionProvider from "../cit/providers/citCompletionProvider";
import citHoverProvider from "../cit/providers/citHoverProvider";
import resourceCompletionProvider from "../providers/resourceCompletionProvider";
import { createResourceDefinitionProvider } from "../providers/resourceDefinitionProvider";
import { createResourceReferenceProvider } from "../providers/resourceReferenceProvider";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigationFacade";
import textureVarDefinitionProvider from "../providers/textureVarDefinitionProvider";
import { getResourceDocumentSelectors } from "../resources/resourceSurfaceRegistry";

const resourceReferenceSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("references");
const textureVariableSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("textureVariables");
const citLanguageSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("citLanguage");
const citCodeActionSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("citCodeAction");

export function registerLanguageProviders(
  context: vscode.ExtensionContext,
  navigation: ResourceUniverseNavigation
): void {
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    resourceReferenceSelectors,
    createResourceDefinitionProvider(navigation)
  ));

  context.subscriptions.push(vscode.languages.registerReferenceProvider(
    resourceReferenceSelectors,
    createResourceReferenceProvider(navigation)
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
