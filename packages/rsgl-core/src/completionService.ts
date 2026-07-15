import {
  getRsglCompletionCandidatesForContext,
  type RsglCompletionCandidate
} from "./completionData";
import { getRsglCompletionContext } from "./completionContext";
import { callablePresentation } from "./languageIntelligence";
import type { RsglSymbol, RsglTypeAliasSymbol } from "./semantic";
import { formatType } from "./semantic/typeRelations";

export type RsglCompletionItemKind =
  | RsglCompletionCandidate["kind"]
  | "variable"
  | "struct"
  | "module"
  | "file";

export interface RsglCompletionItem {
  label: string;
  insertText?: string;
  detail: string;
  kind: RsglCompletionItemKind;
}

export type RsglCompletionNamespace = "value" | "type" | "both";

/** Merges syntax-aware candidates with workspace symbols, keeping syntax items first. */
export function getRsglCompletionItems(
  text: string,
  offset: number,
  semanticSymbols: readonly RsglSymbol[] = [],
  typeAliases: ReadonlyMap<string, RsglTypeAliasSymbol> = new Map(),
  namespace: RsglCompletionNamespace = "both"
): RsglCompletionItem[] {
  const items = new Map<string, RsglCompletionItem>();
  const context = getRsglCompletionContext(text, offset);
  if (namespace !== "type") {
    for (const candidate of getRsglCompletionCandidatesForContext(context)) {
      items.set(candidate.label, candidateCompletionItem(candidate));
    }
    if (!context.blockstateModelOptions) {
      for (const symbol of semanticSymbols) {
        if (!items.has(symbol.name)) {
          items.set(symbol.name, symbolCompletionItem(symbol));
        }
      }
    }
  }
  const collidingTypeAliases: RsglCompletionItem[] = [];
  if (namespace !== "value" && !context.blockstateModelOptions) {
    for (const [name, alias] of typeAliases) {
      const item = {
        label: name,
        kind: "struct" as const,
        detail: `type alias: ${formatType(alias.type ?? { kind: "Unknown" })}`
      };
      if (!items.has(name)) {
        items.set(name, item);
      } else if (namespace === "both") {
        // Value and type namespaces are independent. Keep both candidates so
        // import/export and other syntactically ambiguous positions do not
        // silently hide one declaration behind the other.
        collidingTypeAliases.push(item);
      }
    }
  }
  return [...items.values(), ...collidingTypeAliases];
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
  if (symbol.kind === "namespace") {
    return "module";
  }
  if (symbol.kind === "template" || symbol.signature || symbol.type.kind === "Function") {
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
  const callable = callablePresentation(symbol);
  if (callable) {
    return callable.detail ? `${callable.label} — ${callable.detail}` : callable.label;
  }
  return formatType(symbol.type);
}
