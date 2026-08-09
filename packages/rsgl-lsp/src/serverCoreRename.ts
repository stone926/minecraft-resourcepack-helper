import type {
  Range,
  TextEdit,
  WorkspaceEdit
} from "vscode-languageserver/node";
import {
  getRsglDocumentRenameEdits,
  prepareRsglDocumentRename,
  type RsglRenameEdit
} from "../../rsgl-core/src";
import {
  coreDocument,
  safeLanguageFeature,
  type RsglDocumentLanguageIntelligenceDeps,
  type RsglLspDocument
} from "./serverCoreDocuments";
import {
  loadTargetDocumentOnce,
  toLspOffsetRange,
  type RsglLoadedTargetDocuments,
  type RsglLocationTargetDocument
} from "./serverCoreLocations";

/** Prepares a namespace alias/member rename and converts its source offsets. */
export function prepareRenameForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentLanguageIntelligenceDeps
): { range: Range; placeholder: string } | null {
  return safeLanguageFeature<{ range: Range; placeholder: string } | null>(() => {
    const target = prepareRsglDocumentRename(coreDocument(document, fileName), offset, deps);
    return target
      ? {
          range: toLspOffsetRange(document, target.range),
          placeholder: target.placeholder
        }
      : null;
  }, null);
}

/** Returns protocol-neutral rename edits; target documents are converted separately. */
export function renameEditsForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  newName: string,
  deps: RsglDocumentLanguageIntelligenceDeps
): RsglRenameEdit[] | null {
  return safeLanguageFeature<RsglRenameEdit[] | null>(
    () => getRsglDocumentRenameEdits(
      coreDocument(document, fileName),
      offset,
      newName,
      deps
    ) ?? null,
    null
  );
}

/** Target document required to convert one core offset edit into an LSP edit. */
export type RsglRenameTargetDocument = RsglLocationTargetDocument;

/** Converts a complete cross-file rename atomically. */
export async function toLspWorkspaceEdit(
  edits: readonly RsglRenameEdit[],
  loadDocument: (fileName: string) => Promise<RsglRenameTargetDocument | null>
): Promise<WorkspaceEdit | null> {
  try {
    const loadedDocuments: RsglLoadedTargetDocuments = new Map();
    const changes = new Map<string, TextEdit[]>();
    for (const edit of edits) {
      const targetDocument = await loadTargetDocumentOnce(
        edit.fileName,
        loadedDocuments,
        loadDocument
      );
      if (!targetDocument) {
        return null;
      }
      const documentEdits = changes.get(targetDocument.uri) ?? [];
      if (!changes.has(targetDocument.uri)) {
        changes.set(targetDocument.uri, documentEdits);
      }
      documentEdits.push({
        range: toLspOffsetRange(targetDocument, edit.range),
        newText: edit.newText
      });
    }
    return { changes: Object.fromEntries(changes) };
  } catch {
    return null;
  }
}
