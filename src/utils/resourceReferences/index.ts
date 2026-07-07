import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import { getCitPropertyReferences } from "../citProperties";
import { isInArea } from "../locationChecker";
import { getReferencesForDocumentKind } from "./dispatch";
import { getShaderDocumentSource, getShaderReferences, isShaderDocumentKind } from "./shaderRefs";
import {
  getResourceReferenceDocumentKind,
  type ResourceReference,
  type ResourceReferenceDocument,
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

const resourceReferenceCache = new WeakMap<ResourceReferenceDocument, CachedResourceReferences>();

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

  const cachedReferences = getCachedResourceReferences(document);
  if (cachedReferences) {
    return cachedReferences;
  }

  if (isShaderDocumentKind(documentKind)) {
    const references = getShaderReferences(document.getText(), getShaderDocumentSource(documentKind));
    setCachedResourceReferences(document, references);
    return references;
  }

  if (documentKind === "citProperties") {
    const references = getCitPropertyReferences(document.getText(), document.fileName);
    setCachedResourceReferences(document, references);
    return references;
  }

  const ast = workspaceResourceCache.getJsonAst(document);
  if (!ast) {
    return [];
  }

  const references = getReferencesForDocumentKind(ast, documentKind, document.fileName);
  setCachedResourceReferences(document, references);
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
  version: number;
  references: ResourceReference[];
}

function getCachedResourceReferences(document: ResourceReferenceDocument): ResourceReference[] | null {
  if (typeof document.version !== "number") {
    return null;
  }

  const cached = resourceReferenceCache.get(document);
  if (!cached || cached.fileName !== document.fileName || cached.version !== document.version) {
    return null;
  }

  return cached.references;
}

function setCachedResourceReferences(document: ResourceReferenceDocument, references: ResourceReference[]): void {
  if (typeof document.version === "number") {
    resourceReferenceCache.set(document, {
      fileName: document.fileName,
      version: document.version,
      references
    });
  }
}
