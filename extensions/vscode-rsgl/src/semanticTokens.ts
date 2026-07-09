import * as vscode from "vscode";
import {
  rsglSemanticTokenModifiers,
  rsglSemanticTokenTypes
} from "../../../packages/rsgl-core/src/semanticTokens";
import { getRsglDocumentSemanticTokens } from "../../../packages/rsgl-core/src/languageService";
import type { RsglWorkspaceSemanticCache } from "../../../packages/rsgl-core/src/workspaceSemantic";

/** Legend mirroring the transport-neutral RSGL semantic token legend. */
export const rsglSemanticTokensLegend = new vscode.SemanticTokensLegend(
  [...rsglSemanticTokenTypes],
  [...rsglSemanticTokenModifiers]
);

/**
 * Creates the in-process fallback semantic tokens provider. It resolves the
 * bound model through the same workspace semantic cache used for diagnostics,
 * so both transports highlight identical token sets. `onDidChangeSemanticTokens`
 * lets the host re-request tokens after cross-file edits reclassify identifiers.
 */
export function createRsglSemanticTokensProvider(
  semanticCache: RsglWorkspaceSemanticCache,
  onDidChangeSemanticTokens?: vscode.Event<void>
): vscode.DocumentSemanticTokensProvider {
  return {
    onDidChangeSemanticTokens,
    provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
      const builder = new vscode.SemanticTokensBuilder(rsglSemanticTokensLegend);
      try {
        for (const token of getRsglDocumentSemanticTokens(toRsglLanguageDocument(document), semanticCache)) {
          const start = document.positionAt(token.start);
          builder.push(start.line, start.character, token.length, token.tokenType, token.tokenModifiers);
        }
      } catch {
        // Highlighting is best-effort: fall through to whatever was built.
      }
      return builder.build();
    }
  };
}

function toRsglLanguageDocument(document: vscode.TextDocument): { fileName: string; getText(): string } {
  return {
    fileName: document.uri.fsPath || document.fileName,
    getText: () => document.getText()
  };
}
