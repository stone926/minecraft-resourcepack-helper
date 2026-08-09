import {
  CompletionItemKind,
  InsertTextFormat,
  type CompletionItem
} from "vscode-languageserver/node";
import {
  getRsglCompletionItems,
  getRsglDocumentCompletionItems,
  type RsglCompletionItem,
  type RsglSymbol
} from "../../rsgl-core/src";
import {
  coreDocument,
  type RsglDocumentCompletionDeps,
  type RsglLspDocument
} from "./serverCoreDocuments";

/** Merges syntactic completion candidates with workspace symbols by label. */
export function completionItemsForContent(
  text: string,
  offset: number,
  semanticSymbols: readonly RsglSymbol[]
): CompletionItem[] {
  return getRsglCompletionItems(text, offset, semanticSymbols).map(toCompletionItem);
}

/** Computes completion items through the shared core language service. */
export function completionItemsForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentCompletionDeps
): CompletionItem[] {
  return getRsglDocumentCompletionItems(
    coreDocument(document, fileName),
    offset,
    deps
  ).map(toCompletionItem);
}

/** Maps a syntactic completion candidate to an LSP completion item. */
export function toCompletionItem(candidate: RsglCompletionItem): CompletionItem {
  const item: CompletionItem = {
    label: candidate.label,
    kind: toCompletionKind(candidate.kind),
    detail: candidate.detail
  };
  if (candidate.insertText) {
    item.insertText = candidate.insertText;
    if (candidate.kind === "snippet") {
      item.insertTextFormat = InsertTextFormat.Snippet;
    }
  }
  return item;
}

function toCompletionKind(kind: RsglCompletionItem["kind"]): CompletionItemKind {
  if (kind === "snippet") {
    return CompletionItemKind.Snippet;
  }
  if (kind === "function") {
    return CompletionItemKind.Function;
  }
  if (kind === "constant") {
    return CompletionItemKind.Constant;
  }
  if (kind === "property") {
    return CompletionItemKind.Property;
  }
  if (kind === "struct") {
    return CompletionItemKind.Struct;
  }
  if (kind === "file") {
    return CompletionItemKind.File;
  }
  if (kind === "module") {
    return CompletionItemKind.Module;
  }
  if (kind === "variable") {
    return CompletionItemKind.Variable;
  }
  return CompletionItemKind.Keyword;
}

/** Returns the complete identifier touched by an LSP offset. */
export function identifierAtOffset(text: string, offset: number): string | null {
  const clamped = Math.max(0, Math.min(text.length, offset));
  let anchor = clamped;
  if (!isIdentifierCharacter(text[anchor]) && anchor > 0 && isIdentifierCharacter(text[anchor - 1])) {
    anchor--;
  }
  if (!isIdentifierCharacter(text[anchor])) {
    return null;
  }

  let start = anchor;
  let end = anchor + 1;
  while (start > 0 && isIdentifierCharacter(text[start - 1])) {
    start--;
  }
  while (end < text.length && isIdentifierCharacter(text[end])) {
    end++;
  }
  const identifier = text.slice(start, end);
  return /^[A-Za-z_]/.test(identifier) ? identifier : null;
}

function isIdentifierCharacter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}
