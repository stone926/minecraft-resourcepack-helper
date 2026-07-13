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
      return { kind: "global", symbols };
    }
    return {
      kind: scope.kind,
      symbols: new Map(scope.symbols),
      parent: scope.parent ? clone(scope.parent) : linkedGlobalScope
    };
  };
  return clone(callSiteScope);
}
