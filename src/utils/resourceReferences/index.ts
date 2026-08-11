import { normalizePathKey } from "../../../packages/mc-assets/src";
import {
  filterResourceReferencesForSurface,
  getResourceReferenceExtraction
} from "../../resources/resourceSurfaceRegistry";
import { isInArea } from "../locationChecker";
import { getReferencesForDocumentKind } from "./dispatch";
import { getResourceReferenceDocumentKind } from "./documentKind";
import {
  getRegisteredResourceReferenceExtractor,
  getResourceReferenceExtractionGeneration
} from "./extractorRegistry";
import {
  resolveResourceReferenceHost,
  type ResourceReferenceCacheDescriptor,
  type ResourceReferenceHost
} from "./host";
import { getShaderReferences } from "./shaderRefs";
import {
  type ResourceReference,
  type ResourceReferenceDocument,
  type ResourceReferenceDocumentKind,
  type ResourceReferencePosition
} from "./types";

export { getReferencesForDocumentKind } from "./dispatch";
export { getResourceReferenceDocumentKind } from "./documentKind";
export {
  registerResourceReferenceExtractor,
  type RegisteredResourceReferenceExtractor
} from "./extractorRegistry";
export {
  registerDefaultResourceReferenceHost,
  type ResourceReferenceCacheDescriptor,
  type ResourceReferenceHost
} from "./host";
export { isResourceReferenceKind, resourceReferenceKinds } from "./types";
export type {
  ResourceReference,
  ResourceReferenceDocument,
  ResourceReferenceDocumentKind,
  ResourceReferenceKind,
  ResourceReferenceOrigin,
  ResourceReferencePosition,
  ResourceReferenceRelationship,
  ResourceReferenceResolveMode,
  ResourceReferenceValueNode
} from "./types";

export function getResourceReferences(
  document: ResourceReferenceDocument,
  host?: ResourceReferenceHost
): ResourceReference[] {
  const documentKind = getResourceReferenceDocumentKind(document.fileName);
  if (!documentKind) {
    return [];
  }
  const extraction = getResourceReferenceExtraction(documentKind);
  if (!extraction) {
    return [];
  }

  if (extraction.mode === "json" && document.languageId !== "json") {
    return [];
  }

  const resolvedHost = resolveResourceReferenceHost(host);
  const cacheDescriptor = getResourceReferenceCacheDescriptor(
    document,
    documentKind,
    resolvedHost
  );
  const cachedReferences = cacheDescriptor
    ? resolvedHost.getCachedResourceReferences(cacheDescriptor)
    : null;
  if (cachedReferences) {
    return cachedReferences;
  }

  if (extraction.mode === "shader") {
    const references = filterResourceReferencesForSurface(
      documentKind,
      getShaderReferences(document.getText(), extraction.source, document.fileName)
    );
    setCachedResourceReferences(resolvedHost, cacheDescriptor, references);
    return references;
  }

  if (extraction.mode === "registered") {
    const extractor = getRegisteredResourceReferenceExtractor(extraction.id);
    const references = extractor
      ? filterResourceReferencesForSurface(documentKind, extractor(document))
      : [];
    setCachedResourceReferences(resolvedHost, cacheDescriptor, references);
    return references;
  }

  const ast = resolvedHost.getJsonAst(document);
  if (!ast) {
    return [];
  }

  const references = getReferencesForDocumentKind(ast, documentKind, document.fileName);
  setCachedResourceReferences(resolvedHost, cacheDescriptor, references);
  return references;
}

export function findResourceReferenceAtPosition(
  document: ResourceReferenceDocument,
  position: ResourceReferencePosition,
  host?: ResourceReferenceHost
): ResourceReference | null {
  const line = position.line + 1;
  const character = position.character + 1;

  return getResourceReferences(document, host).find(reference =>
    !reference.synthetic &&
    isInArea(line, character, reference.valueNode.hitLoc ?? reference.valueNode.valueLoc ?? reference.valueNode.loc)
  ) ?? null;
}

export function isResourceReferenceDocument(document: ResourceReferenceDocument): boolean {
  const kind = getResourceReferenceDocumentKind(document.fileName);
  if (!kind) {
    return false;
  }
  const extraction = getResourceReferenceExtraction(kind);
  return extraction !== null && (extraction.mode !== "json" || document.languageId === "json");
}

export function isResourceReferenceFileName(fileName: string): boolean {
  return getResourceReferenceDocumentKind(fileName) !== null;
}

function setCachedResourceReferences(
  host: ResourceReferenceHost,
  descriptor: ResourceReferenceCacheDescriptor | null,
  references: ResourceReference[]
): void {
  if (descriptor) {
    host.setCachedResourceReferences(descriptor, references);
  }
}

function getResourceReferenceCacheDescriptor(
  document: ResourceReferenceDocument,
  documentKind: ResourceReferenceDocumentKind,
  host: ResourceReferenceHost
): ResourceReferenceCacheDescriptor | null {
  const version = host.getResourceReferenceDocumentVersion(document);
  if (!version) {
    return null;
  }

  return {
    key: `${getResourceReferenceDocumentKey(document)}\0${version}\0extractors:${getResourceReferenceExtractionGeneration()}`,
    fileName: document.fileName,
    documentKind,
    version
  };
}

function getResourceReferenceDocumentKey(document: ResourceReferenceDocument): string {
  const uri = (document as { uri?: { toString(): string } }).uri;
  return uri ? uri.toString() : normalizePathKey(document.fileName);
}
