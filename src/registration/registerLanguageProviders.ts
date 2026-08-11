import * as vscode from "vscode";
import citCodeActionProvider from "../cit/providers/citCodeActionProvider";
import citCompletionProvider from "../cit/providers/citCompletionProvider";
import citHoverProvider from "../cit/providers/citHoverProvider";
import { createResourceCompletionProvider } from "../providers/resourceCompletionProvider";
import { createResourceDefinitionProvider } from "../providers/resourceDefinitionProvider";
import { createResourceReferenceProvider } from "../providers/resourceReferenceProvider";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigation";
import textureVarDefinitionProvider from "../providers/textureVarDefinitionProvider";
import { getResourceDocumentSelectors } from "../resources/resourceSurfaceRegistry";
import {
  citCompletionTriggerCharacters,
  resourceCompletionTriggerCharacters
} from "./languageProviderTriggers";

export function registerLanguageProviders(
  context: Pick<vscode.ExtensionContext, "subscriptions">,
  navigation: ResourceUniverseNavigation
): void {
  const resourceReferenceSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("references");
  const resourceCompletionSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("completion");
  const textureVariableSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("textureVariables");
  const citLanguageSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("citLanguage");
  const citCodeActionSelectors: vscode.DocumentFilter[] = getResourceDocumentSelectors("citCodeAction");

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
    resourceCompletionSelectors,
    createResourceCompletionProvider(navigation),
    ...resourceCompletionTriggerCharacters
  ));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    citLanguageSelectors,
    citCompletionProvider,
    ...citCompletionTriggerCharacters
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
