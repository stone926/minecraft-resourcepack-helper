import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePathKey } from "../../mc-assets/src";
import {
  CompletionItemKind,
  DiagnosticSeverity,
  type CompletionItem,
  type Diagnostic,
  type Position
} from "vscode-languageserver/node";
import {
  bindRsglModule,
  compileRsglModule,
  compileRsglProgram,
  getRsglCompletionItems,
  getRsglSemanticTokens,
  parseRsgl,
  type RsglCompletionItem,
  type RsglDiagnostic,
  type RsglSemanticModel,
  type RsglSemanticToken,
  type RsglSymbol,
  type RsglWorkspaceSemanticProgram
} from "../../rsgl-core/src";
import { createRsglWorkspaceValidationOptions } from "../../rsgl-core/src/workspaceValidation";

/** Validation settings pushed by the client via initializationOptions or didChangeConfiguration. */
export interface RsglValidationSettings {
  defaultAssetsPath: string | null;
  resourcePackRoots: string[];
}

/** Minimal transport-neutral view of an open text document. */
export interface RsglLspDocument {
  getText(): string;
  positionAt(offset: number): Position;
}

/** Injected collaborators for the document validation pipeline. */
export interface RsglDocumentValidationDeps {
  loadProgramFromEntry(fileName: string): RsglWorkspaceSemanticProgram;
  settings: RsglValidationSettings;
}

/** Normalizes an untyped settings payload into safe validation settings. */
export function toValidationSettings(value: unknown): RsglValidationSettings {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const defaultAssetsPath = typeof record.defaultAssetsPath === "string" && record.defaultAssetsPath.trim().length > 0
    ? record.defaultAssetsPath
    : null;
  const roots = record.resourcePackRoots;
  const resourcePackRoots = Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string")
    : [];
  return { defaultAssetsPath, resourcePackRoots };
}

/** Compiles the document's program and returns LSP diagnostics scoped to the document's file. */
export function computeDocumentDiagnostics(
  document: RsglLspDocument,
  fileName: string,
  deps: RsglDocumentValidationDeps
): Diagnostic[] {
  const currentFileName = normalizeFileName(path.resolve(fileName));
  const semanticProgram = deps.loadProgramFromEntry(fileName);
  if (semanticProgram.files.length > 0) {
    const result = compileRsglProgram(semanticProgram.files, {
      entryFileName: fileName,
      semanticProgram: semanticProgram.program,
      ...workspaceValidationOptionsFor(fileName, deps.settings)
    });
    return result.diagnostics
      .filter(diagnostic => !diagnostic.fileName || normalizeFileName(path.resolve(diagnostic.fileName)) === currentFileName)
      .map(diagnostic => toLspDiagnostic(document, diagnostic));
  }

  const parsed = parseRsgl(document.getText());
  const result = compileRsglModule(parsed, {
    fileName,
    ...workspaceValidationOptionsFor(fileName, deps.settings)
  });
  return result.diagnostics.map(diagnostic => toLspDiagnostic(document, diagnostic));
}

/** Builds filesystem-backed resource validation options for the given source file. */
export function workspaceValidationOptionsFor(
  sourceFileName: string,
  settings: RsglValidationSettings
): ReturnType<typeof createRsglWorkspaceValidationOptions> {
  return createRsglWorkspaceValidationOptions({
    sourceFileName,
    defaultAssetsPath: settings.defaultAssetsPath,
    resourcePackRoots: settings.resourcePackRoots
  });
}

/** Merges syntactic completion candidates with workspace symbols, deduplicated by label. */
export function completionItemsForContent(
  text: string,
  offset: number,
  semanticSymbols: readonly RsglSymbol[]
): CompletionItem[] {
  return getRsglCompletionItems(text, offset, semanticSymbols).map(toCompletionItem);
}

/** Finds the semantic model belonging to the given file within a bound workspace program. */
export function semanticModelForFile(
  semanticProgram: RsglWorkspaceSemanticProgram,
  fileName: string
): RsglSemanticModel | undefined {
  const key = normalizePathKey(path.resolve(fileName));
  return semanticProgram.program.models.find(model => normalizePathKey(path.resolve(model.fileName)) === key);
}

/** Injected collaborators for semantic token computation. */
export interface RsglDocumentSemanticTokenDeps {
  loadProgramFromEntry(fileName: string): RsglWorkspaceSemanticProgram;
}

/**
 * Computes the LSP-encoded semantic tokens for a document, resolving the
 * bound model through the workspace cache with a single-module bind fallback.
 * Never throws; any failure yields an empty token stream.
 */
export function computeDocumentSemanticTokens(
  document: RsglLspDocument,
  fileName: string,
  deps: RsglDocumentSemanticTokenDeps
): number[] {
  try {
    const semanticProgram = deps.loadProgramFromEntry(fileName);
    const model = semanticModelForFile(semanticProgram, fileName)
      ?? bindRsglModule(parseRsgl(document.getText()), { fileName });
    return encodeSemanticTokens(getRsglSemanticTokens(model), document);
  } catch {
    return [];
  }
}

/**
 * Encodes absolute-offset tokens into the LSP relative representation
 * (deltaLine, deltaStartChar, length, tokenType, tokenModifiers). Tokens must
 * already be sorted by start offset, which `getRsglSemanticTokens` guarantees.
 */
export function encodeSemanticTokens(tokens: readonly RsglSemanticToken[], document: RsglLspDocument): number[] {
  const data: number[] = [];
  let previousLine = 0;
  let previousCharacter = 0;
  for (const token of tokens) {
    const position = document.positionAt(token.start);
    const deltaLine = position.line - previousLine;
    const deltaStartChar = deltaLine === 0 ? position.character - previousCharacter : position.character;
    data.push(deltaLine, deltaStartChar, token.length, token.tokenType, token.tokenModifiers);
    previousLine = position.line;
    previousCharacter = position.character;
  }
  return data;
}

/** Maps a syntactic completion candidate to an LSP completion item. */
export function toCompletionItem(candidate: RsglCompletionItem): CompletionItem {
  const item: CompletionItem = {
    label: candidate.label,
    kind: toCompletionKind(candidate.kind),
    detail: candidate.detail
  };
  if (candidate.insertText) {
    item.insertText = candidate.insertText;
  }
  return item;
}

function toCompletionKind(kind: RsglCompletionItem["kind"]): CompletionItemKind {
  if (kind === "snippet") {
    return CompletionItemKind.Snippet;
  }
  if (kind === "function") {
    return CompletionItemKind.Function;
  }
  if (kind === "constant") {
    return CompletionItemKind.Constant;
  }
  if (kind === "property") {
    return CompletionItemKind.Property;
  }
  if (kind === "struct") {
    return CompletionItemKind.Struct;
  }
  if (kind === "file") {
    return CompletionItemKind.File;
  }
  if (kind === "variable") {
    return CompletionItemKind.Variable;
  }
  return CompletionItemKind.Keyword;
}

/** Converts an RSGL diagnostic to an LSP diagnostic, clamping offsets to the document. */
export function toLspDiagnostic(document: RsglLspDocument, diagnostic: RsglDiagnostic): Diagnostic {
  const start = clampOffset(document, diagnostic.range.start);
  const end = Math.max(start + 1, clampOffset(document, diagnostic.range.end));
  return {
    range: {
      start: document.positionAt(start),
      end: document.positionAt(end)
    },
    severity: toLspSeverity(diagnostic.severity),
    code: diagnostic.code,
    source: "RSGL",
    message: diagnostic.message
  };
}

/** Maps an RSGL severity onto the LSP diagnostic severity scale. */
export function toLspSeverity(severity: RsglDiagnostic["severity"]): DiagnosticSeverity {
  if (severity === "warning") {
    return DiagnosticSeverity.Warning;
  }
  if (severity === "info") {
    return DiagnosticSeverity.Information;
  }
  return DiagnosticSeverity.Error;
}

/** Clamps an offset into the valid range of the document's text. */
export function clampOffset(document: RsglLspDocument, offset: number): number {
  return Math.max(0, Math.min(document.getText().length, offset));
}

/** Resolves a document URI to a filesystem path, passing through non-file URIs. */
export function fileNameFromUri(uri: string): string {
  if (uri.startsWith("file:")) {
    return fileURLToPath(uri);
  }
  return uri;
}

/** Normalizes a filesystem path for identity comparisons. */
export function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}
