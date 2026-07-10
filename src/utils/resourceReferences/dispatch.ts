import { JsonDocumentNode } from "../jsonAst";
import {
  getEquipmentReferences,
  getFontReferences,
  getParticleReferences,
  getPostEffectReferences,
  getSoundReferences,
  getWaypointStyleReferences
} from "./assetJsonRefs";
import { getAtlasReferences } from "./atlasRefs";
import { getBlockstateReferences, getCitModelReferences, getItemModelReferences, getModelReferences } from "./blockstateModelRefs";
import { getItemDefinitionReferences } from "./itemDefinitionRefs";
import { ResourceReference, ResourceReferenceDocumentKind } from "./types";

export function getReferencesForDocumentKind(
  ast: JsonDocumentNode,
  documentKind: ResourceReferenceDocumentKind,
  fileName = ""
): ResourceReference[] {
  return extractorsByKind[documentKind]?.(ast, fileName) ?? [];
}

type JsonReferenceExtractor = (ast: JsonDocumentNode, fileName: string) => ResourceReference[];

// shaderCore, shaderPost and citProperties are text documents extracted before
// the JSON AST path (see index.ts), so they have no entry in this table.
const extractorsByKind: Partial<Record<ResourceReferenceDocumentKind, JsonReferenceExtractor>> = {
  blockstates: getBlockstateReferences,
  modelsBlock: ast => getModelReferences(ast, "models/block"),
  modelsItem: getItemModelReferences,
  models: ast => getModelReferences(ast, "models"),
  citModel: getCitModelReferences,
  particles: getParticleReferences,
  items: getItemDefinitionReferences,
  atlases: getAtlasReferences,
  equipment: getEquipmentReferences,
  font: getFontReferences,
  waypointStyle: getWaypointStyleReferences,
  postEffect: getPostEffectReferences,
  sounds: getSoundReferences
};
