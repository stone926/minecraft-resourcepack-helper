import {
  MarkupKind,
  type Hover,
  type SignatureHelp
} from "vscode-languageserver/node";
import {
  getRsglDocumentHoverInfo,
  getRsglDocumentSignatureHelpInfo
} from "../../rsgl-core/src";
import {
  clampOffset,
  coreDocument,
  safeLanguageFeature,
  type RsglDocumentLanguageIntelligenceDeps,
  type RsglLspDocument
} from "./serverCoreDocuments";

/** Computes semantic hover content and converts offsets to LSP positions. */
export function computeDocumentHover(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentLanguageIntelligenceDeps
): Hover | null {
  return safeLanguageFeature<Hover | null>(() => {
    const hover = getRsglDocumentHoverInfo(coreDocument(document, fileName), offset, deps);
    if (!hover) {
      return null;
    }
    const detail = hover.detail ? `\n\n${hover.detail}` : "";
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `\`\`\`rsgl\n${hover.label}\n\`\`\`${detail}`
      },
      range: {
        start: document.positionAt(clampOffset(document, hover.range.start)),
        end: document.positionAt(clampOffset(document, hover.range.end))
      }
    };
  }, null);
}

/** Computes semantic signature help for template and function-valued calls. */
export function computeDocumentSignatureHelp(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentLanguageIntelligenceDeps
): SignatureHelp | null {
  return safeLanguageFeature<SignatureHelp | null>(() => {
    const help = getRsglDocumentSignatureHelpInfo(coreDocument(document, fileName), offset, deps);
    if (!help) {
      return null;
    }
    return {
      signatures: help.signatures.map(signature => ({
        label: signature.label,
        documentation: signature.detail,
        parameters: signature.parameters.map(parameter => ({ label: parameter.label }))
      })),
      activeSignature: help.activeSignature,
      activeParameter: help.activeParameter
    };
  }, null);
}
