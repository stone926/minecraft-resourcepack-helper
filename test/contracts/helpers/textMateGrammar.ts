import * as fs from "node:fs";
import * as path from "node:path";

export interface GrammarCapture {
  name?: string;
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

export function rsglGrammarPath(): string {
  return path.join(process.cwd(), "syntaxes", "rsgl.tmLanguage.json");
}

interface GrammarContext {
  patterns: readonly GrammarPattern[];
  end?: string;
  scope?: string;
}

interface GrammarCandidate {
  kind: "end" | "match" | "begin";
  match: RegExpExecArray;
  pattern?: GrammarPattern;
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

/**
 * Tokenizes the grammar contract with TextMate's earliest-match and begin/end
 * stack semantics. Regexes run in JavaScript rather than Oniguruma, so this is
 * intentionally limited to syntax rules shared by both engines.
 */
export function tokenizeGrammar(grammar: RsglGrammar, source: string): GrammarTokenization {
  const scopes = Array.from({ length: source.length }, () => new Set<string>());
  const contexts: GrammarContext[] = [{ patterns: grammar.patterns ?? [] }];
  let lineStart = 0;

  for (const lineWithCarriageReturn of source.split("\n")) {
    const line = lineWithCarriageReturn.endsWith("\r")
      ? lineWithCarriageReturn.slice(0, -1)
      : lineWithCarriageReturn;
    let cursor = 0;
    let iterations = 0;
    const maxIterations = Math.max(64, line.length * 8);

    while (cursor <= line.length) {
      if (iterations++ >= maxIterations) {
        throw new Error(`TextMate grammar contract exceeded ${maxIterations} iterations on line '${line}'.`);
      }
      const context = contexts.at(-1);
      if (!context) {
        break;
      }
      const candidate = firstCandidate(grammar, context, line, cursor);
      if (!candidate) {
        applyScopes(scopes, lineStart + cursor, lineStart + line.length, activeScopes(contexts));
        break;
      }

      applyScopes(scopes, lineStart + cursor, lineStart + candidate.match.index, activeScopes(contexts));
      const matchEnd = candidate.match.index + candidate.match[0].length;
      applyScopes(scopes, lineStart + candidate.match.index, lineStart + matchEnd, activeScopes(contexts));

      if (candidate.kind === "end") {
        contexts.pop();
      } else if (candidate.pattern) {
        applyPatternScopes(scopes, lineStart, candidate.pattern, candidate.match, candidate.kind === "begin");
        if (candidate.kind === "begin") {
          contexts.push({
            patterns: candidate.pattern.patterns ?? [],
            end: candidate.pattern.end,
            scope: candidate.pattern.name
          });
        }
      }

      if (matchEnd > cursor) {
        cursor = matchEnd;
      } else if (candidate.kind !== "end") {
        cursor++;
      } else if (cursor === line.length && contexts.length === 1) {
        break;
      }
    }

    lineStart += lineWithCarriageReturn.length + 1;
  }

  return {
    scopesAt(offset: number): readonly string[] {
      return [...(scopes[offset] ?? [])];
    }
  };
}

function firstCandidate(
  grammar: RsglGrammar,
  context: GrammarContext,
  line: string,
  cursor: number
): GrammarCandidate | undefined {
  let best: GrammarCandidate | undefined;
  if (context.end) {
    const match = execute(context.end, line, cursor);
    if (match) {
      best = { kind: "end", match };
    }
  }

  for (const pattern of expandIncludes(grammar, context.patterns)) {
    const source = pattern.match ?? pattern.begin;
    if (!source) {
      continue;
    }
    const match = execute(source, line, cursor);
    if (!match || (best && match.index >= best.match.index)) {
      continue;
    }
    best = { kind: pattern.begin ? "begin" : "match", match, pattern };
  }
  return best;
}

function execute(source: string, line: string, cursor: number): RegExpExecArray | null {
  const regex = new RegExp(source, "gd");
  regex.lastIndex = cursor;
  return regex.exec(line);
}

function expandIncludes(grammar: RsglGrammar, patterns: readonly GrammarPattern[]): GrammarPattern[] {
  const expanded: GrammarPattern[] = [];
  for (const pattern of patterns) {
    if (pattern.include?.startsWith("#")) {
      expanded.push(...expandIncludes(grammar, repositoryPatterns(grammar, pattern.include.slice(1))));
    } else if (pattern.include === "$self") {
      expanded.push(...expandIncludes(grammar, grammar.patterns ?? []));
    } else {
      expanded.push(pattern);
    }
  }
  return expanded;
}

function activeScopes(contexts: readonly GrammarContext[]): string[] {
  return contexts.flatMap(context => context.scope ? [context.scope] : []);
}

function applyPatternScopes(
  scopes: Array<Set<string>>,
  lineStart: number,
  pattern: GrammarPattern,
  match: RegExpExecArray,
  begin: boolean
): void {
  const matchEnd = match.index + match[0].length;
  if (pattern.name) {
    applyScopes(scopes, lineStart + match.index, lineStart + matchEnd, [pattern.name]);
  }
  const captures = begin ? pattern.beginCaptures : pattern.captures;
  const indices = (match as RegExpExecArray & {
    indices?: Array<[number, number] | undefined>;
  }).indices;
  if (!captures || !indices) {
    return;
  }
  for (const [rawIndex, capture] of Object.entries(captures)) {
    const range = indices[Number(rawIndex)];
    if (capture.name && range) {
      applyScopes(scopes, lineStart + range[0], lineStart + range[1], [capture.name]);
    }
  }
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
