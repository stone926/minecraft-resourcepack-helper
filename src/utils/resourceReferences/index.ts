import { normalizePathKey } from "../../../packages/mc-assets/src";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import { LruCache } from "../../services/lruCache";
import { getCitPropertyReferences } from "../../cit/citProperties";
import { isInArea } from "../locationChecker";
import { getReferencesForDocumentKind } from "./dispatch";
import { getShaderDocumentSource, getShaderReferences, isShaderDocumentKind } from "./shaderRefs";
import {
  getResourceReferenceDocumentKind,
  type ResourceReference,
  type ResourceReferenceDocument,
  type ResourceReferenceDocumentKind,
  type ResourceReferencePosition
} from "./types";

export { getResourceReferencesForAst } from "./dispatch";
export { getResourceReferenceDocumentKind } from "./types";
export type {
  ResourceReference,
  ResourceReferenceDocument,
  ResourceReferenceDocumentKind,
  ResourceReferenceOrigin,
  ResourceReferencePosition,
  ResourceReferenceRelationship,
  ResourceReferenceResolveMode,
  ResourceReferenceValueNode
} from "./types";

const resourceReferenceCache = new LruCache<string, CachedResourceReferences>(2048);

export function getResourceReferences(document: ResourceReferenceDocument): ResourceReference[] {
  const documentKind = getResourceReferenceDocumentKind(document.fileName);
  if (!documentKind) {
    return [];
  }

  if (
    documentKind !== "citProperties" &&
    documentKind !== "citModel" &&
    document.languageId !== "json" &&
    !isShaderDocumentKind(documentKind)
  ) {
    return [];
  }

  const cachedReferences = getCachedResourceReferences(document, documentKind);
  if (cachedReferences) {
    return cachedReferences;
  }

  if (isShaderDocumentKind(documentKind)) {
    const references = getShaderReferences(document.getText(), getShaderDocumentSource(documentKind));
    setCachedResourceReferences(document, documentKind, references);
    return references;
  }

  if (documentKind === "citProperties") {
    const references = getCitPropertyReferences(document);
    setCachedResourceReferences(document, documentKind, references);
    return references;
  }

  const ast = workspaceResourceCache.getJsonAst(document);
  if (!ast) {
    return [];
  }

  const references = getReferencesForDocumentKind(ast, documentKind, document.fileName);
  setCachedResourceReferences(document, documentKind, references);
  return references;
}

export function findResourceReferenceAtPosition(document: ResourceReferenceDocument, position: ResourceReferencePosition): ResourceReference | null {
  const line = position.line + 1;
  const character = position.character + 1;

  return getResourceReferences(document).find(reference =>
    !reference.synthetic &&
    isInArea(line, character, reference.valueNode.hitLoc ?? reference.valueNode.valueLoc ?? reference.valueNode.loc)
  ) ?? null;
}

export function isResourceReferenceDocument(document: ResourceReferenceDocument): boolean {
  const kind = getResourceReferenceDocumentKind(document.fileName);
  return kind !== null && (document.languageId === "json" || isShaderDocumentKind(kind) || kind === "citProperties" || kind === "citModel");
}

export function isResourceReferenceFileName(fileName: string): boolean {
  return getResourceReferenceDocumentKind(fileName) !== null;
}

interface CachedResourceReferences {
  fileName: string;
  documentKind: ResourceReferenceDocumentKind;
  version: string;
  references: ResourceReference[];
}

function getCachedResourceReferences(
  document: ResourceReferenceDocument,
  documentKind: ResourceReferenceDocumentKind
): ResourceReference[] | null {
  const cacheDescriptor = getResourceReferenceCacheDescriptor(document);
  if (!cacheDescriptor) {
    return null;
  }

  const cached = resourceReferenceCache.get(cacheDescriptor.key);
  if (!cached || cached.fileName !== document.fileName || cached.documentKind !== documentKind || cached.version !== cacheDescriptor.version) {
    return null;
  }

  return cached.references;
}

function setCachedResourceReferences(
  document: ResourceReferenceDocument,
  documentKind: ResourceReferenceDocumentKind,
  references: ResourceReference[]
): void {
  const cacheDescriptor = getResourceReferenceCacheDescriptor(document);
  if (cacheDescriptor) {
    resourceReferenceCache.set(cacheDescriptor.key, {
      fileName: document.fileName,
      documentKind,
      version: cacheDescriptor.version,
      references
    });
  }
}

interface ResourceReferenceCacheDescriptor {
  key: string;
  version: string;
}

function getResourceReferenceCacheDescriptor(document: ResourceReferenceDocument): ResourceReferenceCacheDescriptor | null {
  const version = getResourceReferenceDocumentVersion(document);
  if (!version) {
    return null;
  }

  return {
    key: `${getResourceReferenceDocumentKey(document)}\0${version}`,
    version
  };
}

function getResourceReferenceDocumentVersion(document: ResourceReferenceDocument): string | null {
  if (typeof document.version === "number") {
    return `open:${document.version}`;
  }

  const fileVersion = workspaceResourceCache.getFileVersion(document.fileName);
  return fileVersion ? `file:${fileVersion}` : null;
}

function getResourceReferenceDocumentKey(document: ResourceReferenceDocument): string {
  const uri = (document as { uri?: { toString(): string } }).uri;
  return uri ? uri.toString() : normalizePathKey(document.fileName);
}
