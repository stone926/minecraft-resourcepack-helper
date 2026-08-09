import type { Location } from "vscode-languageserver/node";
import {
  getRsglDocumentDefinitionLocations,
  getRsglDocumentReferenceLocations,
  type RsglDefinitionLocation,
  type RsglReferenceLocation
} from "../../rsgl-core/src";
import {
  coreDocument,
  safeLanguageFeature,
  type RsglDocumentLanguageIntelligenceDeps,
  type RsglLspDocument
} from "./serverCoreDocuments";
import {
  loadTargetDocumentOnce,
  toLspOffsetLocation,
  type RsglLoadedTargetDocuments,
  type RsglLocationTargetDocument
} from "./serverCoreLocations";

/** Returns the first offset-based definition target, when one exists. */
export function definitionLocationForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentLanguageIntelligenceDeps
): RsglDefinitionLocation | null {
  return definitionLocationsForDocument(document, fileName, offset, deps)[0] ?? null;
}

/** Returns every offset-based definition target. */
export function definitionLocationsForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentLanguageIntelligenceDeps
): RsglDefinitionLocation[] {
  return safeLanguageFeature<RsglDefinitionLocation[]>(
    () => getRsglDocumentDefinitionLocations(coreDocument(document, fileName), offset, deps),
    []
  );
}

/** Converts a core definition range using the target document's UTF-16 mapping. */
export function toLspDefinitionLocation(
  targetDocument: RsglLspDocument,
  targetUri: string,
  definition: RsglDefinitionLocation
): Location {
  return toLspOffsetLocation(targetDocument, targetUri, definition);
}

/** Converts all definition targets while loading each target document once. */
export function toLspDefinitionLocations(
  definitions: readonly RsglDefinitionLocation[],
  loadDocument: (fileName: string) => Promise<RsglLocationTargetDocument | null>
): Promise<Location[]> {
  return toLspReferenceLocations(definitions, loadDocument);
}

/** Returns offset-based references; target-document conversion stays separate. */
export function referenceLocationsForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  includeDeclaration: boolean,
  deps: RsglDocumentLanguageIntelligenceDeps
): RsglReferenceLocation[] {
  return safeLanguageFeature<RsglReferenceLocation[]>(
    () => getRsglDocumentReferenceLocations(
      coreDocument(document, fileName),
      offset,
      includeDeclaration,
      deps
    ),
    []
  );
}

/** Converts and preserves a stable list of cross-file core locations. */
export async function toLspReferenceLocations(
  locations: readonly RsglReferenceLocation[],
  loadDocument: (fileName: string) => Promise<RsglLocationTargetDocument | null>
): Promise<Location[]> {
  const loadedDocuments: RsglLoadedTargetDocuments = new Map();
  const result: Location[] = [];
  for (const location of locations) {
    const targetDocument = await loadTargetDocumentOnce(
      location.fileName,
      loadedDocuments,
      loadDocument
    );
    if (targetDocument) {
      result.push(toLspOffsetLocation(targetDocument, targetDocument.uri, location));
    }
  }
  return result;
}
