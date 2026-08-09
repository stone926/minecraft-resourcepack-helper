import type { Position } from "vscode-languageserver/node";
import type {
  RsglLanguageDocument,
  RsglLanguageWorkspace
} from "../../rsgl-core/src";

/** Minimal transport-neutral view of an open text document. */
export interface RsglLspDocument {
  getText(): string;
  positionAt(offset: number): Position;
  readonly version?: number;
}

/** Injected collaborators for completion computation and project target lookup. */
export type RsglDocumentCompletionDeps = RsglLanguageWorkspace;

/** Injected collaborators shared by hover, signature help, and definition lookup. */
export type RsglDocumentLanguageIntelligenceDeps = RsglDocumentCompletionDeps;

export function coreDocument(
  document: RsglLspDocument,
  fileName: string
): RsglLanguageDocument {
  return {
    fileName,
    getText: () => document.getText()
  };
}

export function safeLanguageFeature<TResult>(
  compute: () => TResult,
  fallback: TResult
): TResult {
  try {
    return compute();
  } catch {
    return fallback;
  }
}

/** Clamps an offset into the valid range of the document's text. */
export function clampOffset(document: RsglLspDocument, offset: number): number {
  return Math.max(0, Math.min(document.getText().length, offset));
}
