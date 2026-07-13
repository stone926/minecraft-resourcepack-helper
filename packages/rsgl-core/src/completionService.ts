import {
  getRsglCompletionCandidates,
  type RsglCompletionCandidate
} from "./completionData";
import type { RsglSymbol } from "./semantic";
import { formatTemplateOutputMetadata } from "./templateOutput";

export type RsglCompletionItemKind =
  | RsglCompletionCandidate["kind"]
  | "variable"
  | "struct"
  | "file";

export interface RsglCompletionItem {
  label: string;
  insertText?: string;
  detail: string;
  kind: RsglCompletionItemKind;
}

/** Merges syntax-aware candidates with workspace symbols, keeping syntax items first. */
export function getRsglCompletionItems(
  text: string,
  offset: number,
  semanticSymbols: readonly RsglSymbol[] = []
): RsglCompletionItem[] {
  const items = new Map<string, RsglCompletionItem>();
  for (const candidate of getRsglCompletionCandidates(text, offset)) {
    items.set(candidate.label, candidateCompletionItem(candidate));
  }
  for (const symbol of semanticSymbols) {
    if (!items.has(symbol.name)) {
      items.set(symbol.name, symbolCompletionItem(symbol));
    }
  }
  return [...items.values()];
}

function candidateCompletionItem(candidate: RsglCompletionCandidate): RsglCompletionItem {
  return {
    label: candidate.label,
    kind: candidate.kind,
    detail: candidate.detail,
    insertText: candidate.insertText
  };
}

function symbolCompletionItem(symbol: RsglSymbol): RsglCompletionItem {
  return {
    label: symbol.name,
    kind: symbolCompletionKind(symbol),
    detail: `${symbol.kind}: ${formatSymbolType(symbol)}`
  };
}

function symbolCompletionKind(symbol: RsglSymbol): RsglCompletionItemKind {
  if (symbol.kind === "template" || symbol.signature?.templateOutput) {
    return "function";
  }
  if (symbol.kind === "table") {
    return "struct";
  }
  if (symbol.kind === "resource") {
    return "file";
  }
  return "variable";
}

function formatSymbolType(symbol: RsglSymbol): string {
  if (symbol.signature) {
    return symbol.signature.templateOutput
      ? formatTemplateOutputMetadata(symbol.signature.templateOutput)
      : "function";
  }
  return symbol.type.kind;
}
