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
import {
  buildResourceCompletionInsertion,
  decodeJsonStringContent,
  type ResourceCompletionValueSyntax
} from "../utils/resourceCompletionEdits";
import { findResourceReferenceAtPosition, type ResourceReference } from "../utils/resourceReferences";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import { toVscodeRange } from "../utils/resourceLocationVscode";
import { rangeInsideString } from "../utils/resourceRange";

interface ResourceCompletionContext {
  reference: ResourceReference;
  documentFileName: string;
  documentUri: string;
  insertingRange: vscode.Range;
  replacingRange: vscode.Range;
  insertPrefix: string;
  insertSuffix: string;
  valueSyntax: ResourceCompletionValueSyntax;
}

export const triggerResourceCompletionCommand = internalCommands.triggerResourceCompletion;

export function createResourceCompletionProvider(
  navigation?: Pick<ResourceUniverseNavigation, "getKnownResources">
): vscode.CompletionItemProvider {
  const resourceCompletionService = new ResourceCompletionService(workspaceResourceCache, navigation);
  return {
    async provideCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
      cancellationToken: vscode.CancellationToken
    ) {
      const context = getResourceCompletionContext(document, position);
      if (!context) {
        return null;
      }

      const requestedVersion = document.version;

      const candidates = await resourceCompletionService.getCompletionCandidates({
        documentFileName: context.documentFileName,
        reference: context.reference,
        configuration: getResourceConfiguration()
      });
      if (cancellationToken.isCancellationRequested || document.version !== requestedVersion) {
        return null;
      }
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
    const replacingRange = rangeInsideString(reference.valueNode);
    if (!replacingRange?.isSingleLine || !replacingRange.contains(position)) {
      return null;
    }
    const insertingRange = new vscode.Range(replacingRange.start, position);
    const rawPrefix = document.getText(insertingRange);
    const value = document.languageId === "json"
      ? decodeJsonStringContent(rawPrefix)
      : rawPrefix;
    if (value === null) {
      return null;
    }
    return {
      reference: { ...reference, value },
      documentFileName: document.fileName,
      documentUri: document.uri.toString(),
      insertingRange,
      replacingRange,
      insertPrefix: "",
      insertSuffix: "",
      valueSyntax: document.languageId === "json" ? "jsonString" : "plain"
    };
  }

  const inferredContext = inferIncompleteResourceCompletionContext(document, position);
  if (!inferredContext) {
    return null;
  }

  return {
    reference: inferredContext.reference,
    documentFileName: document.fileName,
    documentUri: document.uri.toString(),
    insertingRange: toVscodeRange(inferredContext.insertingRange),
    replacingRange: toVscodeRange(inferredContext.replacingRange),
    insertPrefix: inferredContext.insertPrefix,
    insertSuffix: inferredContext.insertSuffix,
    valueSyntax: document.languageId === "json" ? "jsonString" : "plain"
  };
}

function createCompletionItem(
  candidate: ResourceCompletionCandidate,
  context: ResourceCompletionContext
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(candidate.label, completionItemKind(candidate));
  item.range = {
    inserting: context.insertingRange,
    replacing: context.replacingRange
  };
  item.filterText = candidate.filterText;
  const insertion = buildResourceCompletionInsertion(
    candidate.value,
    context.valueSyntax,
    context.insertPrefix,
    context.insertSuffix,
    candidate.retriggerSuggest
  );
  item.insertText = insertion.snippet
    ? new vscode.SnippetString(insertion.text)
    : insertion.text;
  if (candidate.retriggerSuggest) {
    item.command = createTriggerSuggestCommand(context.documentUri);
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

function createTriggerSuggestCommand(documentUri: string): vscode.Command {
  return {
    command: triggerResourceCompletionCommand,
    title: vscode.l10n.t("Suggest"),
    arguments: [documentUri]
  };
}
