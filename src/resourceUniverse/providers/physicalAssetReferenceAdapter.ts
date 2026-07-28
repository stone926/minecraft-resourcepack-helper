import {
  getResourceReferences,
  type ResourceReference,
  type ResourceReferenceDocument
} from "../../utils/resourceReferences";
import { isEditableUri } from "../core/identity";
import type { ResourceLayerRole } from "../core";
import type {
  PhysicalResourceDocumentFact,
  PhysicalResourceReferenceFact
} from "./physicalAssetSnapshot";

export interface PhysicalAssetScannedDocument extends ResourceReferenceDocument {
  uri: string;
  revision: string;
  layerId: string;
  layerRole: ResourceLayerRole;
  outputPath: string;
}

export type PhysicalAssetReferenceExtractor = (
  document: ResourceReferenceDocument
) => readonly ResourceReference[];

/**
 * Focused bridge from the legacy JSON/shader/CIT extractor contract to
 * provider-neutral physical facts. Resolved target URIs are deliberately not
 * persisted: the universe resolves canonical logical targets at query time.
 */
export function adaptPhysicalAssetDocuments(
  documents: readonly PhysicalAssetScannedDocument[],
  extractReferences: PhysicalAssetReferenceExtractor = getResourceReferences
): PhysicalResourceDocumentFact[] {
  return documents.map(document => ({
    uri: document.uri,
    fileName: document.fileName,
    revision: document.revision,
    layerId: document.layerId,
    layerRole: document.layerRole,
    outputPath: document.outputPath,
    references: extractReferences(document).map(reference =>
      physicalReferenceFact(document, reference)
    )
  }));
}

function physicalReferenceFact(
  document: PhysicalAssetScannedDocument,
  reference: ResourceReference
): PhysicalResourceReferenceFact {
  const range = referenceRange(document.getText(), reference);
  return {
    targetKind: reference.kind,
    value: reference.value,
    target: reference.target,
    source: reference.source,
    extension: reference.extension,
    scope: "effective",
    relationship: reference.relationship,
    sourceLocation: range ? {
      uri: document.uri,
      range,
      origin: "physical",
      editable: isEditableUri(document.uri)
    } : undefined
  };
}

function referenceRange(
  text: string,
  reference: ResourceReference
): { start: number; end: number } | undefined {
  const location = reference.valueNode.valueLoc ?? reference.valueNode.loc;
  if (!location) {
    return undefined;
  }
  const lineStarts = getLineStarts(text);
  const start = offsetAt(lineStarts, text.length, location.start.line, location.start.column);
  const end = offsetAt(lineStarts, text.length, location.end.line, location.end.column);
  return start === undefined || end === undefined
    ? undefined
    : { start, end: Math.max(start, end) };
}

function getLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function offsetAt(
  lineStarts: readonly number[],
  textLength: number,
  oneBasedLine: number,
  oneBasedColumn: number
): number | undefined {
  const lineStart = lineStarts[oneBasedLine - 1];
  if (lineStart === undefined) {
    return undefined;
  }
  return Math.min(textLength, lineStart + Math.max(0, oneBasedColumn - 1));
}

