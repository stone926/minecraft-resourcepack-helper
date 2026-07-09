import * as vscode from "vscode";
import { citResourceIdService } from "../citResourceIdService";
import { getResourceConfiguration } from "../../utils/resourceConfiguration";
import {
  getCitCompletionResult,
  type CitCompletionCandidate,
  type CitResourceCompletionData,
  type CitTextRange
} from "../citLanguage";

const pendingCompletionRefreshes = new Set<string>();

const citCompletionProvider: vscode.CompletionItemProvider = {
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
    const resources = getCompletionResourceIds(document);
    const result = getCitCompletionResult(document, position, vscode.env.language, resources);
    if (!result || result.candidates.length === 0) {
      return null;
    }

    const range = toVsCodeRange(result.range);
    return result.candidates.map(candidate => toCompletionItem(candidate, range));
  }
};

export default citCompletionProvider;

function getCompletionResourceIds(document: vscode.TextDocument): CitResourceCompletionData {
  const configuration = getResourceConfiguration();
  const cachedResourceIds = citResourceIdService.getCachedResourceIds(document.fileName, configuration);
  if (cachedResourceIds) {
    return cachedResourceIds;
  }

  const refreshKey = [
    document.uri.toString(),
    document.version,
    configuration.defaultAssetsPath ?? "",
    (configuration.resourcePackRoots ?? []).join("|")
  ].join("\0");
  if (!pendingCompletionRefreshes.has(refreshKey)) {
    pendingCompletionRefreshes.add(refreshKey);
    citResourceIdService.warmResourceIds(document.fileName, configuration, () => {
      pendingCompletionRefreshes.delete(refreshKey);
      if (vscode.window.activeTextEditor?.document === document) {
        void vscode.commands.executeCommand("editor.action.triggerSuggest");
      }
    });
  }

  return citResourceIdService.getBuiltinResourceIds();
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

function toVsCodeRange(range: CitTextRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  );
}
