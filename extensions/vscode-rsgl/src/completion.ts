import * as vscode from "vscode";
import {
  getRsglCompletionItems,
  type RsglCompletionItem
} from "../../../packages/rsgl-core/src/completionService";
import type { RsglSymbol } from "../../../packages/rsgl-core/src/semantic";
import type { RsglWorkspaceSemanticCache } from "../../../packages/rsgl-core/src/workspaceSemantic";
import { semanticModelForRsglDocument } from "./semanticWorkspace";

export function createRsglCompletionProvider(
  semanticCache: RsglWorkspaceSemanticCache
): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
      const offset = document.offsetAt(position);
      return getRsglCompletionItems(
        document.getText(),
        offset,
        semanticSymbolsForDocument(document, semanticCache)
      ).map(toCompletionItem);
    }
  };
}

function semanticSymbolsForDocument(
  document: vscode.TextDocument,
  semanticCache: RsglWorkspaceSemanticCache
): RsglSymbol[] {
  try {
    return semanticModelForRsglDocument(document, semanticCache).symbols;
  } catch {
    return [];
  }
}

function toCompletionItem(candidate: RsglCompletionItem): vscode.CompletionItem {
  const item = new vscode.CompletionItem(candidate.label, toCompletionKind(candidate.kind));
  item.detail = candidate.detail;
  if (candidate.insertText) {
    item.insertText = new vscode.SnippetString(candidate.insertText);
  }
  return item;
}

function toCompletionKind(kind: RsglCompletionItem["kind"]): vscode.CompletionItemKind {
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
  if (kind === "struct") {
    return vscode.CompletionItemKind.Struct;
  }
  if (kind === "file") {
    return vscode.CompletionItemKind.File;
  }
  if (kind === "variable") {
    return vscode.CompletionItemKind.Variable;
  }
  return vscode.CompletionItemKind.Keyword;
}
