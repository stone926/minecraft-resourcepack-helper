import * as vscode from "vscode";
import { getRsglDocumentCompletionItems } from "../../../packages/rsgl-core/src/languageService";
import {
  type RsglCompletionItem
} from "../../../packages/rsgl-core/src/completionService";
import type { RsglWorkspaceSemanticCache } from "../../../packages/rsgl-core/src/workspaceSemantic";

export function createRsglCompletionProvider(
  semanticCache: RsglWorkspaceSemanticCache
): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
      const offset = document.offsetAt(position);
      return getRsglDocumentCompletionItems(
        toRsglLanguageDocument(document),
        offset,
        semanticCache
      ).map(toCompletionItem);
    }
  };
}

function toRsglLanguageDocument(document: vscode.TextDocument): { fileName: string; getText(): string } {
  return {
    fileName: document.uri.fsPath || document.fileName,
    getText: () => document.getText()
  };
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
