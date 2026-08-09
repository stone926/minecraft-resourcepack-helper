import {
  getRsglDocumentSemanticTokens,
  type RsglSemanticToken,
  type RsglWorkspaceSemanticProgram
} from "../../rsgl-core/src";
import {
  coreDocument,
  safeLanguageFeature,
  type RsglLspDocument
} from "./serverCoreDocuments";

/** Injected collaborators for semantic token computation. */
export interface RsglDocumentSemanticTokenDeps {
  loadProgramFromEntry(fileName: string): RsglWorkspaceSemanticProgram;
}

/** Computes the LSP-encoded semantic tokens for a document. */
export function computeDocumentSemanticTokens(
  document: RsglLspDocument,
  fileName: string,
  deps: RsglDocumentSemanticTokenDeps
): number[] {
  return safeLanguageFeature<number[]>(() => {
    const tokens = getRsglDocumentSemanticTokens(coreDocument(document, fileName), deps);
    return encodeSemanticTokens(tokens, document);
  }, []);
}

/** Encodes absolute-offset tokens into the LSP relative representation. */
export function encodeSemanticTokens(
  tokens: readonly RsglSemanticToken[],
  document: RsglLspDocument
): number[] {
  const data: number[] = [];
  let previousLine = 0;
  let previousCharacter = 0;
  for (const token of tokens) {
    const position = document.positionAt(token.start);
    const deltaLine = position.line - previousLine;
    const deltaStartChar = deltaLine === 0
      ? position.character - previousCharacter
      : position.character;
    data.push(deltaLine, deltaStartChar, token.length, token.tokenType, token.tokenModifiers);
    previousLine = position.line;
    previousCharacter = position.character;
  }
  return data;
}
