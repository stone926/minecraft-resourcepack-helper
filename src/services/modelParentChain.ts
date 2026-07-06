import {
  JsonDocumentNode,
  memberName,
  objectMembers,
  stringValue
} from "../utils/jsonAst";
import { normalizePathKey } from "../../packages/mc-assets/src";
import type { ResourceConfiguration, ResourceResolveRequest } from "./workspaceResourceCache";

export interface CachedModelDocument {
  ast: JsonDocumentNode;
  fileName: string;
  source: string;
}

export interface CachedTextureVariableDefinition {
  fileName: string;
  line: number;
  character: number;
}

export interface ModelParentChainHost {
  resolveResourcePath(request: ResourceResolveRequest): string | null;
  getJsonFileAst(fileName: string): JsonDocumentNode | null;
}

export function loadModelParentChain(
  host: ModelParentChainHost,
  fileName: string,
  ast: JsonDocumentNode,
  source: string,
  configuration: ResourceConfiguration
): CachedModelDocument[] {
  const models: CachedModelDocument[] = [{
    ast,
    fileName,
    source
  }];
  const visited = new Set([normalizePathKey(fileName)]);

  while (models.length <= 11) {
    const current = models[models.length - 1];
    const parent = findParentModel(current.ast);
    if (!parent) {
      break;
    }

    const parentFileName = host.resolveResourcePath({
      resourcePath: parent,
      sourceFileName: current.fileName,
      target: "models",
      source: current.source,
      targetFileExtension: "json",
      defaultAssetsPath: configuration.defaultAssetsPath,
      resourcePackRoots: configuration.resourcePackRoots
    });
    if (!parentFileName) {
      break;
    }

    const parentKey = normalizePathKey(parentFileName);
    if (visited.has(parentKey)) {
      break;
    }
    visited.add(parentKey);

    const parentAst = host.getJsonFileAst(parentFileName);
    if (!parentAst) {
      break;
    }

    models.push({
      ast: parentAst,
      fileName: parentFileName,
      source: modelSourceForFile(parentFileName)
    });
  }

  return models;
}

export function collectModelTextureVariableDefinitions(chain: CachedModelDocument[]): Map<string, CachedTextureVariableDefinition> {
  const definitions = new Map<string, CachedTextureVariableDefinition>();
  for (const model of chain) {
    const textures = objectMembers(model.ast.body).find(member => memberName(member) === "textures");
    for (const texture of objectMembers(textures?.value)) {
      const name = memberName(texture);
      const location = texture.name?.loc ?? texture.loc;
      if (name && location && !definitions.has(name)) {
        definitions.set(name, {
          fileName: model.fileName,
          line: location.start.line - 1,
          character: location.start.column - 1
        });
      }
    }
  }

  return definitions;
}

export function findParentModel(ast: JsonDocumentNode): string | null {
  const parent = objectMembers(ast.body).find(member => memberName(member) === "parent");
  return stringValue(parent?.value) ?? null;
}

export function modelSourceForFile(fileName: string): string {
  if (/[\\/]models[\\/]item[\\/]/i.test(fileName)) {
    return "models/item";
  }

  if (/[\\/]models[\\/]block[\\/]/i.test(fileName)) {
    return "models/block";
  }

  return "models";
}
