import type { TextRange } from "../parser";
import type { RsglSemanticModel, RsglSymbol } from "./types";

export interface RsglSymbolDefinitionLocation {
  fileName: string;
  range: TextRange;
}

export interface RsglSymbolDefinition extends RsglSymbolDefinitionLocation {
  symbol: RsglSymbol;
}

/**
 * Resolves a linked import/re-export symbol back to the declaration that owns
 * its AST node. Import aliases deliberately reuse the original node during
 * linking, so identity of the wrapper symbol itself is not an ownership test.
 */
export function originalRsglSymbolDefinition(
  models: readonly RsglSemanticModel[],
  symbol: RsglSymbol
): RsglSymbolDefinitionLocation | undefined {
  const definition = originalRsglSymbolDeclaration(models, symbol);
  return definition
    ? { fileName: definition.fileName, range: definition.range }
    : undefined;
}

export function originalRsglSymbolDeclaration(
  models: readonly RsglSemanticModel[],
  symbol: RsglSymbol
): RsglSymbolDefinition | undefined {
  if (!symbol.node) {
    return undefined;
  }

  const definitions = models.flatMap(model => model.symbols
    .filter(candidate =>
      candidate.node === symbol.node
      && candidate.kind !== "import"
      && candidate.kind !== "namespace"
      && candidate.range
    )
    .map(candidate => ({
      fileName: model.fileName,
      range: candidate.range!,
      symbol: candidate
    })));

  return definitions.sort((left, right) =>
    rangeLength(left.range) - rangeLength(right.range)
    || left.fileName.localeCompare(right.fileName, "en")
    || left.range.start - right.range.start
  )[0];
}

function rangeLength(range: TextRange): number {
  return Math.max(0, range.end - range.start);
}
