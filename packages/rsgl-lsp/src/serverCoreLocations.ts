import * as path from "node:path";
import { normalizePathKey } from "../../mc-assets/src";
import type {
  Location,
  Range
} from "vscode-languageserver/node";
import {
  clampOffset,
  type RsglLspDocument
} from "./serverCoreDocuments";

/** A target text document used to map core offsets to LSP locations. */
export interface RsglLocationTargetDocument extends RsglLspDocument {
  uri: string;
}

export type RsglLoadedTargetDocuments = Map<string, RsglLocationTargetDocument | null>;

export function toLspOffsetRange(
  targetDocument: RsglLspDocument,
  range: { start: number; end: number }
): Range {
  return {
    start: targetDocument.positionAt(clampOffset(targetDocument, range.start)),
    end: targetDocument.positionAt(clampOffset(targetDocument, range.end))
  };
}

export function toLspOffsetLocation(
  targetDocument: RsglLspDocument,
  targetUri: string,
  location: { range: { start: number; end: number } }
): Location {
  return {
    uri: targetUri,
    range: toLspOffsetRange(targetDocument, location.range)
  };
}

export async function loadTargetDocumentOnce(
  fileName: string,
  loadedDocuments: RsglLoadedTargetDocuments,
  loadDocument: (fileName: string) => Promise<RsglLocationTargetDocument | null>
): Promise<RsglLocationTargetDocument | null> {
  const fileKey = normalizePathKey(path.resolve(fileName));
  if (loadedDocuments.has(fileKey)) {
    return loadedDocuments.get(fileKey) ?? null;
  }
  let document: RsglLocationTargetDocument | null = null;
  try {
    document = await loadDocument(fileName);
  } catch {
    // Callers decide whether an unreadable target is skippable or atomic.
  }
  loadedDocuments.set(fileKey, document);
  return document;
}
