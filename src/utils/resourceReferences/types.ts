import { AstLocation } from "../locationChecker";

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

export type ResourceReferenceKind = "model" | "texture" | "textureDirectory" | "font" | "fontFile" | "shader" | "sound";
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

export type ResourceReferenceDocumentKind =
  | "blockstates"
  | "modelsBlock"
  | "modelsItem"
  | "models"
  | "particles"
  | "items"
  | "atlases"
  | "equipment"
  | "font"
  | "waypointStyle"
  | "postEffect"
  | "sounds"
  | "shaderCore"
  | "shaderPost"
  | "citModel"
  | "citProperties";
