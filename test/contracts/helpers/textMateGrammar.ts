import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  INITIAL,
  Registry,
  parseRawGrammar,
  type IGrammar,
  type IOnigLib,
  type StateStack
} from "vscode-textmate";
import { loadWASM, OnigScanner, OnigString } from "vscode-oniguruma";

export interface GrammarCapture {
  name?: string;
  patterns?: GrammarPattern[];
}

export interface GrammarPattern {
  name?: string;
  match?: string;
  begin?: string;
  end?: string;
  include?: string;
  captures?: Record<string, GrammarCapture>;
  beginCaptures?: Record<string, GrammarCapture>;
  patterns?: GrammarPattern[];
}

export interface GrammarRepositoryEntry {
  patterns?: GrammarPattern[];
}

export interface RsglGrammar {
  patterns?: GrammarPattern[];
  repository?: Record<string, GrammarRepositoryEntry>;
}

export interface GrammarTokenization {
  scopesAt(offset: number): readonly string[];
}

const moduleRequire = createRequire(path.join(process.cwd(), "package.json"));
let grammarPromise: Promise<IGrammar> | undefined;
let loadedGrammar: IGrammar | undefined;

export function rsglGrammarPath(): string {
  return path.join(process.cwd(), "syntaxes", "rsgl.tmLanguage.json");
}

export function readGrammarText(): string {
  return fs.readFileSync(rsglGrammarPath(), "utf8");
}

export function readGrammar(): RsglGrammar {
  return JSON.parse(readGrammarText()) as RsglGrammar;
}

export function repositoryPatterns(grammar: RsglGrammar, name: string): GrammarPattern[] {
  return grammar.repository?.[name]?.patterns ?? [];
}

/** Loads the same Oniguruma WASM and TextMate engine used by VS Code. */
export async function initializeGrammarTokenizer(): Promise<void> {
  grammarPromise ??= loadGrammar();
  loadedGrammar = await grammarPromise;
}

/**
 * Tokenizes RSGL with vscode-textmate and vscode-oniguruma. The structural
 * grammar argument keeps callers explicit about the artifact under test; the
 * executable grammar is loaded from that artifact once in the suite setup.
 */
export function tokenizeGrammar(grammar: RsglGrammar, source: string): GrammarTokenization {
  if (!grammar.patterns || !loadedGrammar) {
    throw new Error("RSGL TextMate tokenizer is not initialized.");
  }
  const scopes = Array.from({ length: source.length }, () => new Set<string>());
  let lineStart = 0;
  let ruleStack: StateStack = INITIAL;

  for (const lineWithCarriageReturn of source.split("\n")) {
    const line = lineWithCarriageReturn.endsWith("\r")
      ? lineWithCarriageReturn.slice(0, -1)
      : lineWithCarriageReturn;
    const result = loadedGrammar.tokenizeLine(line, ruleStack);
    ruleStack = result.ruleStack;
    for (const token of result.tokens) {
      const tokenScopes = token.scopes.filter(scope => scope !== "source.rsgl");
      applyScopes(
        scopes,
        lineStart + token.startIndex,
        lineStart + Math.min(token.endIndex, line.length),
        tokenScopes
      );
    }
    lineStart += lineWithCarriageReturn.length + 1;
  }

  return {
    scopesAt(offset: number): readonly string[] {
      return [...(scopes[offset] ?? [])];
    }
  };
}

async function loadGrammar(): Promise<IGrammar> {
  const wasmFile = moduleRequire.resolve("vscode-oniguruma/release/onig.wasm");
  const wasmBytes = fs.readFileSync(wasmFile);
  await loadWASM(wasmBytes.buffer.slice(
    wasmBytes.byteOffset,
    wasmBytes.byteOffset + wasmBytes.byteLength
  ));
  const onigLib: Promise<IOnigLib> = Promise.resolve({
    createOnigScanner: sources => new OnigScanner(sources),
    createOnigString: source => new OnigString(source)
  });
  const registry = new Registry({
    onigLib,
    loadGrammar: async scopeName => scopeName === "source.rsgl"
      ? parseRawGrammar(readGrammarText(), rsglGrammarPath())
      : null
  });
  const grammar = await registry.loadGrammar("source.rsgl");
  if (!grammar) {
    throw new Error("Unable to load source.rsgl TextMate grammar.");
  }
  return grammar;
}

function applyScopes(
  scopes: Array<Set<string>>,
  start: number,
  end: number,
  names: readonly string[]
): void {
  for (let offset = Math.max(0, start); offset < Math.min(end, scopes.length); offset++) {
    for (const name of names) {
      scopes[offset].add(name);
    }
  }
}
