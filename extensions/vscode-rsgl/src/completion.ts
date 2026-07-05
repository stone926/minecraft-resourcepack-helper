import * as vscode from "vscode";
import { getRsglCompletionCandidates, RsglCompletionCandidate } from "../../../packages/rsgl-core/src/completionData";

export const rsglCompletionProvider: vscode.CompletionItemProvider = {
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
    const offset = document.offsetAt(position);
    return getRsglCompletionCandidates(document.getText(), offset).map(toCompletionItem);
  }
};

function toCompletionItem(candidate: RsglCompletionCandidate): vscode.CompletionItem {
  const item = new vscode.CompletionItem(candidate.label, toCompletionKind(candidate.kind));
  item.detail = candidate.detail;
  if (candidate.insertText) {
    item.insertText = new vscode.SnippetString(candidate.insertText);
  }
  return item;
}

function toCompletionKind(kind: RsglCompletionCandidate["kind"]): vscode.CompletionItemKind {
  if (kind === "snippet") {
    return vscode.CompletionItemKind.Snippet;
  }
  if (kind === "function") {
    return vscode.CompletionItemKind.Function;
  }
  if (kind === "constant") {
    return vscode.CompletionItemKind.Constant;
  }
  if (kind === "property") {
    return vscode.CompletionItemKind.Property;
  }
  return vscode.CompletionItemKind.Keyword;
}
