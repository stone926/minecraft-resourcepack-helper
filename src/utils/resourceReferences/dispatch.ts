import { JsonDocumentNode } from "../jsonAst";
import {
  filterResourceReferencesForSurface,
  getResourceReferenceExtraction
} from "../../resources/resourceSurfaceRegistry";
import { ResourceReference, ResourceReferenceDocumentKind } from "./types";

export function getReferencesForDocumentKind(
  ast: JsonDocumentNode,
  documentKind: ResourceReferenceDocumentKind,
  fileName = ""
): ResourceReference[] {
  const extraction = getResourceReferenceExtraction(documentKind);
  return extraction?.mode === "json"
    ? filterResourceReferencesForSurface(documentKind, extraction.extract(ast, fileName))
    : [];
}
