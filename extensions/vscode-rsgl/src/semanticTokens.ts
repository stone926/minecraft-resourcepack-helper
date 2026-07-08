import * as vscode from "vscode";
import * as path from "node:path";
import { normalizePathKey } from "../../../packages/mc-assets/src";
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
  const key = normalizePathKey(path.resolve(fileName));
  const model = semanticProgram.program.models.find(candidate =>
    normalizePathKey(path.resolve(candidate.fileName)) === key
  );
  return model ?? bindRsglModule(parseRsgl(document.getText()), { fileName });
}
