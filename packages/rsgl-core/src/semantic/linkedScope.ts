import type { RsglScope } from "./types";

/**
 * Keeps a call-site lexical snapshot authoritative while filling names that
 * only a completed bare-import/re-export link pass could add to the global.
 */
export function scopeWithLinkedGlobalFallback(
  callSiteScope: RsglScope,
  linkedGlobalScope: RsglScope
): RsglScope {
  const clone = (scope: RsglScope): RsglScope => {
    if (scope.kind === "global") {
      const symbols = new Map(linkedGlobalScope.symbols);
      for (const [name, symbol] of scope.symbols) {
        symbols.set(name, symbol);
      }
      const typeAliases = new Map(linkedGlobalScope.typeAliases);
      for (const [name, alias] of scope.typeAliases) {
        typeAliases.set(name, alias);
      }
      return { kind: "global", symbols, typeAliases };
    }
    return {
      kind: scope.kind,
      symbols: new Map(scope.symbols),
      typeAliases: new Map(scope.typeAliases),
      parent: scope.parent ? clone(scope.parent) : linkedGlobalScope
    };
  };
  return clone(callSiteScope);
}
