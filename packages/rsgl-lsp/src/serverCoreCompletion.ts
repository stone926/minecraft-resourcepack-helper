import {
  CompletionItemKind,
  InsertTextFormat,
  type CompletionItem
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
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
  semanticSymbols: readonly RsglSymbol[],
  insertReplaceSupport = true
): CompletionItem[] {
  const document = TextDocument.create("inmemory://rsgl/completion.rsgl", "rsgl", 0, text);
  return getRsglCompletionItems(text, offset, semanticSymbols)
    .map(candidate => toCompletionItem(
      candidate,
      value => document.positionAt(value),
      insertReplaceSupport
    ));
}

/** Computes completion items through the shared core language service. */
export function completionItemsForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentCompletionDeps,
  insertReplaceSupport = true
): CompletionItem[] {
  return getRsglDocumentCompletionItems(
    coreDocument(document, fileName),
    offset,
    deps
  ).map(candidate => toCompletionItem(
    candidate,
    value => document.positionAt(value),
    insertReplaceSupport
  ));
}

/** Maps a syntactic completion candidate to an LSP completion item. */
export function toCompletionItem(
  candidate: RsglCompletionItem,
  positionAt?: (offset: number) => { line: number; character: number },
  insertReplaceSupport = true
): CompletionItem {
  const item: CompletionItem = {
    label: candidate.label,
    kind: toCompletionKind(candidate.kind),
    detail: candidate.detail
  };
  if (candidate.edit && positionAt) {
    const replace = {
      start: positionAt(candidate.edit.replace.start),
      end: positionAt(candidate.edit.replace.end)
    };
    item.textEdit = insertReplaceSupport
      ? {
          newText: candidate.edit.newText,
          insert: {
            start: positionAt(candidate.edit.insert.start),
            end: positionAt(candidate.edit.insert.end)
          },
          replace
        }
      : { newText: candidate.edit.newText, range: replace };
  } else if (candidate.insertText) {
    item.insertText = candidate.insertText;
  }
  if (candidate.insertTextFormat === "snippet") {
    item.insertTextFormat = InsertTextFormat.Snippet;
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
