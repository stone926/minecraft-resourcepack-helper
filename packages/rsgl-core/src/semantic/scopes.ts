import { RsglScope, RsglSymbol } from "./types";

export function createScope(kind: RsglScope["kind"], parent?: RsglScope): RsglScope {
  return { kind, parent, symbols: new Map() };
}

export function createChildScope(parent: RsglScope, kind: RsglScope["kind"]): RsglScope {
  return createScope(kind, parent);
}

export function lookup(scope: RsglScope, name: string): RsglSymbol | undefined {
  let current: RsglScope | undefined = scope;
  while (current) {
    const symbol = current.symbols.get(name);
    if (symbol) {
      return symbol;
    }
    current = current.parent;
  }
  return undefined;
}
