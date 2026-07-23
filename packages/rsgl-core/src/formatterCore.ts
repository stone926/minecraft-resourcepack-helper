import { lexRsgl, parseRsgl } from "./parser";
import { applyRsglDocumentLayout } from "./formatter/layout";
import { buildRsglFormatDocument } from "./formatter/lines";
import {
  normalizeRsglFormatOptions,
  rsglFormattingStyleRules,
  type RsglFormatOptions
} from "./formatter/options";
import { printRsglFormatDocument } from "./formatter/printer";
import {
  collectRsglFormatterSyntaxFacts,
  type RsglFormatterSyntaxFacts
} from "./formatter/syntaxFacts";

export * from "./formatter/options";

/**
 * Formats RSGL without reconstructing syntax tokens. Strings, template
 * strings, comments, invalid tokens, and extern globs retain their source
 * spelling; only layout trivia is rewritten.
 *
 * The numeric overload remains for API compatibility and means a space-based
 * indentation width.
 */
export function formatRsglText(
  text: string,
  options?: number | Partial<RsglFormatOptions>
): string {
  const resolvedOptions = normalizeRsglFormatOptions(options);
  const factsAndTokens = formatterInput(text);
  const rules = rsglFormattingStyleRules(resolvedOptions.style);
  const document = buildRsglFormatDocument(factsAndTokens.tokens);
  applyRsglDocumentLayout(document, factsAndTokens.facts, resolvedOptions, rules);
  return printRsglFormatDocument(
    document,
    factsAndTokens.facts,
    resolvedOptions,
    rules
  );
}

function formatterInput(text: string): {
  tokens: ReturnType<typeof lexRsgl>["tokens"];
  facts: RsglFormatterSyntaxFacts;
} {
  try {
    const module = parseRsgl(text);
    return {
      tokens: module.tokens,
      facts: collectRsglFormatterSyntaxFacts(module)
    };
  } catch {
    return {
      tokens: lexRsgl(text).tokens,
      facts: emptySyntaxFacts()
    };
  }
}

function emptySyntaxFacts(): RsglFormatterSyntaxFacts {
  return {
    bodyOpenOffsets: new Set(),
    bodyBracePairs: [],
    collectionOpenOffsets: new Set(),
    delimiterDepthByTokenOffset: new Map(),
    tightTokenPairs: new Set(),
    unaryOperatorOffsets: new Set(),
    spacedOperatorOffsets: new Set(),
    indexOpenOffsets: new Set()
  };
}
