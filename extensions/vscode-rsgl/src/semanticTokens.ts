import * as vscode from "vscode";
import * as path from "node:path";
import { parseRsgl } from "../../../packages/rsgl-core/src/parser";
import { bindRsglModule, type RsglSemanticModel } from "../../../packages/rsgl-core/src/semantic";
import {
  getRsglSemanticTokens,
  rsglSemanticTokenModifiers,
  rsglSemanticTokenTypes
} from "../../../packages/rsgl-core/src/semanticTokens";
import type { RsglWorkspaceSemanticCache } from "../../../packages/rsgl-core/src/workspaceSemantic";

/** Legend mirroring the transport-neutral RSGL semantic token legend. */
export const rsglSemanticTokensLegend = new vscode.SemanticTokensLegend(
  [...rsglSemanticTokenTypes],
  [...rsglSemanticTokenModifiers]
);

/**
 * Creates the in-process fallback semantic tokens provider. It resolves the
 * bound model through the same workspace semantic cache used for diagnostics,
 * so both transports highlight identical token sets.
 */
export function createRsglSemanticTokensProvider(
  semanticCache: RsglWorkspaceSemanticCache
): vscode.DocumentSemanticTokensProvider {
  return {
    provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
      const builder = new vscode.SemanticTokensBuilder(rsglSemanticTokensLegend);
      try {
        const model = semanticModelForDocument(document, semanticCache);
        for (const token of getRsglSemanticTokens(model)) {
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

function semanticModelForDocument(
  document: vscode.TextDocument,
  semanticCache: RsglWorkspaceSemanticCache
): RsglSemanticModel {
  const fileName = document.uri.fsPath || document.fileName;
  const semanticProgram = semanticCache.loadProgramFromEntry(fileName);
  const normalized = normalizeFileName(path.resolve(fileName));
  const model = semanticProgram.program.models.find(candidate =>
    normalizeFileName(path.resolve(candidate.fileName)) === normalized
  );
  return model ?? bindRsglModule(parseRsgl(document.getText()), { fileName });
}

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}
