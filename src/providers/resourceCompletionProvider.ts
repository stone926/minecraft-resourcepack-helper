import { internalCommands } from "../commandIds";
import * as vscode from "vscode";
import {
  ResourceCompletionService,
  type ResourceCompletionCandidate
} from "../services/resourceCompletionService";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigation";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import {
  inferIncompleteResourceCompletionContext
} from "../utils/resourceCompletionContext";
import { findResourceReferenceAtPosition, type ResourceReference } from "../utils/resourceReferences";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import { toVscodeRange } from "../utils/resourceLocationVscode";
import { rangeInsideString } from "../utils/resourceRange";

interface ResourceCompletionContext {
  reference: ResourceReference;
  documentFileName: string;
  replacementRange: vscode.Range;
  includeQuotes: boolean;
}

export const triggerResourceCompletionCommand = internalCommands.triggerResourceCompletion;

export function createResourceCompletionProvider(
  navigation?: Pick<ResourceUniverseNavigation, "getKnownResources">
): vscode.CompletionItemProvider {
  const resourceCompletionService = new ResourceCompletionService(workspaceResourceCache, navigation);
  return {
    async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
      const context = getResourceCompletionContext(document, position);
      if (!context) {
        return null;
      }

      const candidates = await resourceCompletionService.getCompletionCandidates({
        documentFileName: context.documentFileName,
        reference: context.reference,
        configuration: getResourceConfiguration()
      });
      const items = candidates.map(candidate => createCompletionItem(candidate, context));

      return items.length > 0 ? items : null;
    }
  };
}

const resourceCompletionProvider = createResourceCompletionProvider();

export default resourceCompletionProvider;

function getResourceCompletionContext(document: vscode.TextDocument, position: vscode.Position): ResourceCompletionContext | null {
  const reference = findResourceReferenceAtPosition(document, position);
  if (reference) {
    const replacementRange = rangeInsideString(reference.valueNode);
    return replacementRange ? { reference, documentFileName: document.fileName, replacementRange, includeQuotes: false } : null;
  }

  const inferredContext = inferIncompleteResourceCompletionContext(document, position);
  if (!inferredContext) {
    return null;
  }

  return {
    reference: inferredContext.reference,
    documentFileName: document.fileName,
    replacementRange: toVscodeRange(inferredContext.replacementRange),
    includeQuotes: inferredContext.includeQuotes
  };
}

function createCompletionItem(
  candidate: ResourceCompletionCandidate,
  context: ResourceCompletionContext
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(candidate.label, completionItemKind(candidate));
  item.range = context.replacementRange;
  item.filterText = candidate.filterText;
  item.insertText = buildCompletionInsertText(
    candidate.value,
    context.includeQuotes,
    candidate.retriggerSuggest
  );
  if (candidate.retriggerSuggest) {
    item.command = createTriggerSuggestCommand();
  }
  return item;
}

function completionItemKind(candidate: ResourceCompletionCandidate): vscode.CompletionItemKind {
  switch (candidate.kind) {
    case "namespace":
      return vscode.CompletionItemKind.Module;
    case "directory":
      return vscode.CompletionItemKind.Folder;
    case "file":
      return vscode.CompletionItemKind.File;
  }
}

function createTriggerSuggestCommand(): vscode.Command {
  return { command: triggerResourceCompletionCommand, title: vscode.l10n.t("Suggest") };
}

function buildCompletionInsertText(value: string, includeQuotes: boolean, keepCursorInsideQuotes: boolean): string | vscode.SnippetString {
  if (!includeQuotes) {
    return value;
  }

  const escapedValue = escapeSnippet(value);
  return new vscode.SnippetString(keepCursorInsideQuotes ? `"${escapedValue}$0"` : `"${escapedValue}"$0`);
}

function escapeSnippet(value: string): string {
  return value.replace(/[\\$}]/g, "\\$&");
}
