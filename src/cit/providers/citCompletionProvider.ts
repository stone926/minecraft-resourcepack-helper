import * as vscode from "vscode";
import { toVscodeRange } from "../../utils/resourceLocationVscode";
import { citResourceIdService } from "../citResourceIdService";
import { getResourceConfiguration } from "../../utils/resourceConfiguration";
import {
  getCitCompletionResult,
  type CitCompletionCandidate,
  type CitResourceCompletionData
} from "../citLanguage";

const citCompletionProvider: vscode.CompletionItemProvider = {
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
    const resources = getCompletionResourceIds(document);
    const result = getCitCompletionResult(document, position, vscode.env.language, resources);
    if (!result || result.candidates.length === 0) {
      return null;
    }

    const range = toVscodeRange(result.range);
    return result.candidates.map(candidate => toCompletionItem(candidate, range));
  }
};

export default citCompletionProvider;

function getCompletionResourceIds(document: vscode.TextDocument): CitResourceCompletionData {
  const configuration = getResourceConfiguration();
  const requestedVersion = document.version;
  return citResourceIdService.getResourceIdsForHotPath(
    document.fileName,
    configuration,
    {
      key: `completion\0${document.uri.toString()}`,
      onReady: () => {
        if (vscode.window.activeTextEditor?.document === document) {
          // A newer document version gets its own completion request and
          // replaces this keyed subscriber while the shared warmup is pending.
          if (document.version === requestedVersion) {
            void vscode.commands.executeCommand("editor.action.triggerSuggest");
          }
        }
      }
    }
  );
}

function toCompletionItem(candidate: CitCompletionCandidate, range: vscode.Range): vscode.CompletionItem {
  const item = new vscode.CompletionItem(candidate.label, toCompletionItemKind(candidate));
  item.range = range;
  item.insertText = candidate.insertText;
  item.detail = candidate.detail;
  item.documentation = candidate.documentation ? new vscode.MarkdownString(candidate.documentation) : undefined;
  if (candidate.triggerSuggest) {
    item.command = {
      command: "editor.action.triggerSuggest",
      title: vscode.l10n.t("Suggest")
    };
  }
  return item;
}

function toCompletionItemKind(candidate: CitCompletionCandidate): vscode.CompletionItemKind {
  if (candidate.kind === "key") {
    return vscode.CompletionItemKind.Property;
  }
  if (candidate.kind === "resource") {
    return vscode.CompletionItemKind.Value;
  }
  return vscode.CompletionItemKind.EnumMember;
}
