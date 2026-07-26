import { normalizePathKey } from "../../../packages/mc-assets/src";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import { LruCache } from "../../services/lruCache";
import { openDocumentFileVersion } from "../../services/resourceCacheTypes";
import { getCitPropertyReferences } from "../../cit/citProperties";
import {
  filterResourceReferencesForSurface,
  getResourceReferenceExtraction
} from "../../resources/resourceSurfaceRegistry";
import { isInArea } from "../locationChecker";
import { getReferencesForDocumentKind } from "./dispatch";
import { getResourceReferenceDocumentKind } from "./documentKind";
import { getShaderReferences } from "./shaderRefs";
import {
  type ResourceReference,
  type ResourceReferenceDocument,
  type ResourceReferenceDocumentKind,
  type ResourceReferencePosition
} from "./types";

export { getReferencesForDocumentKind } from "./dispatch";
export { getResourceReferenceDocumentKind } from "./documentKind";
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

const resourceReferenceCache = new LruCache<string, CachedResourceReferences>(2048);

export function getResourceReferences(document: ResourceReferenceDocument): ResourceReference[] {
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

  const cachedReferences = getCachedResourceReferences(document, documentKind);
  if (cachedReferences) {
    return cachedReferences;
  }

  if (extraction.mode === "shader") {
    const references = filterResourceReferencesForSurface(
      documentKind,
      getShaderReferences(document.getText(), extraction.source)
    );
    setCachedResourceReferences(document, documentKind, references);
    return references;
  }

  if (extraction.mode === "citProperties") {
    const references = filterResourceReferencesForSurface(documentKind, getCitPropertyReferences(document));
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
  if (!kind) {
    return false;
  }
  const extraction = getResourceReferenceExtraction(kind);
  return extraction !== null && (extraction.mode !== "json" || document.languageId === "json");
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
    return openDocumentFileVersion(document.version);
  }

  const fileVersion = workspaceResourceCache.getFileVersion(document.fileName);
  return fileVersion ? `file:${fileVersion}` : null;
}

function getResourceReferenceDocumentKey(document: ResourceReferenceDocument): string {
  const uri = (document as { uri?: { toString(): string } }).uri;
  return uri ? uri.toString() : normalizePathKey(document.fileName);
}
