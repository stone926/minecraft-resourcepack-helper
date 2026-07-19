import type { RsglNode, TextRange } from "../parser";
import type { RsglSemanticModel, RsglSymbol } from "./types";

export interface RsglSymbolDefinitionLocation {
  fileName: string;
  range: TextRange;
}

export interface RsglSymbolDefinition extends RsglSymbolDefinitionLocation {
  symbol: RsglSymbol;
}

export interface RsglSymbolDefinitionIndex {
  definitionsByNode: ReadonlyMap<RsglNode, readonly RsglSymbolDefinition[]>;
}

const definitionIndexesByModels = new WeakMap<object, RsglSymbolDefinitionIndex>();

/**
 * Resolves a linked import/re-export symbol back to the declaration that owns
 * its AST node. Import aliases deliberately reuse the original node during
 * linking, so identity of the wrapper symbol itself is not an ownership test.
 */
export function originalRsglSymbolDefinition(
  models: readonly RsglSemanticModel[],
  symbol: RsglSymbol,
  index?: RsglSymbolDefinitionIndex
): RsglSymbolDefinitionLocation | undefined {
  const definition = originalRsglSymbolDeclaration(models, symbol, index);
  return definition
    ? { fileName: definition.fileName, range: definition.range }
    : undefined;
}

export function originalRsglSymbolDeclaration(
  models: readonly RsglSemanticModel[],
  symbol: RsglSymbol,
  index: RsglSymbolDefinitionIndex = createRsglSymbolDefinitionIndex(models)
): RsglSymbolDefinition | undefined {
  if (!symbol.node) {
    return undefined;
  }

  const definitions = [...(index.definitionsByNode.get(symbol.node) ?? [])];

  const exactNameDefinitions = definitions.filter(definition =>
    definition.symbol.name === symbol.name
  );
  return (exactNameDefinitions.length > 0 ? exactNameDefinitions : definitions).sort((left, right) =>
    rangeLength(left.range) - rangeLength(right.range)
    || left.fileName.localeCompare(right.fileName, "en")
    || left.range.start - right.range.start
  )[0];
}

/**
 * Collapses linked import/re-export wrappers to the declaration-owned symbol.
 * Symbols without a source declaration (builtins and namespace aliases) retain
 * their local identity.
 */
export function canonicalRsglSymbol(
  models: readonly RsglSemanticModel[],
  symbol: RsglSymbol,
  index?: RsglSymbolDefinitionIndex
): RsglSymbol {
  return originalRsglSymbolDeclaration(models, symbol, index)?.symbol ?? symbol;
}

export function createRsglSymbolDefinitionIndex(
  models: readonly RsglSemanticModel[]
): RsglSymbolDefinitionIndex {
  const cached = definitionIndexesByModels.get(models);
  if (cached) {
    return cached;
  }
  const definitionsByNode = new Map<RsglNode, RsglSymbolDefinition[]>();
  for (const model of models) {
    for (const symbol of model.symbols) {
      if (!symbol.node || !symbol.range || symbol.kind === "import" || symbol.kind === "namespace") {
        continue;
      }
      const definitions = definitionsByNode.get(symbol.node) ?? [];
      definitions.push({ fileName: model.fileName, range: symbol.range, symbol });
      definitionsByNode.set(symbol.node, definitions);
    }
  }
  const index = { definitionsByNode };
  definitionIndexesByModels.set(models, index);
  return index;
}

function rangeLength(range: TextRange): number {
  return Math.max(0, range.end - range.start);
}
