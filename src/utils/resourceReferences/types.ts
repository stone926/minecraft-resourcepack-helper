import { AstLocation } from "../locationChecker";
export type { ResourceReferenceDocumentKind } from "../../resources/resourceSurfaceRegistry";

export interface ResourceReference {
  value: string;
  valueNode: ResourceReferenceValueNode;
  target: string;
  source: string;
  extension: string | null;
  kind: ResourceReferenceKind;
  relationship?: ResourceReferenceRelationship;
  resolveMode?: ResourceReferenceResolveMode;
  origin?: ResourceReferenceOrigin;
  synthetic?: boolean;
}

export interface ResourceReferenceValueNode {
  loc?: AstLocation | null;
  valueLoc?: AstLocation | null;
  hitLoc?: AstLocation | null;
}

export const resourceReferenceKinds = [
  "model",
  "texture",
  "textureDirectory",
  "font",
  "fontFile",
  "shader",
  "sound"
] as const;

export type ResourceReferenceKind = (typeof resourceReferenceKinds)[number];

export function isResourceReferenceKind(value: string): value is ResourceReferenceKind {
  return (resourceReferenceKinds as readonly string[]).includes(value);
}
export type ResourceReferenceRelationship = "modelParent";
export type ResourceReferenceResolveMode = "cit";
export type ResourceReferenceOrigin = "citAutoDiscovery";

export interface ResourceReferenceDocument {
  languageId: string;
  fileName: string;
  version?: number;
  getText(): string;
}

export interface ResourceReferencePosition {
  line: number;
  character: number;
}
