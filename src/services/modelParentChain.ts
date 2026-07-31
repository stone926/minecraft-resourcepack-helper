import {
  JsonDocumentNode,
  memberName,
  objectMembers,
  stringValue
} from "../utils/jsonAst";
import { modelSourceForFileName } from "../resources/resourceSurfaceRegistry";
import type { ResourceFileRequest } from "../../packages/mc-assets/src";
import type { ResourceConfiguration } from "./resourceCacheTypes";
import { ModelParentTraversal } from "./modelParentTraversal";

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
  resolveResourcePath(request: ResourceFileRequest): string | null;
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
  const traversal = new ModelParentTraversal(fileName);

  while (true) {
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

    const advance = traversal.advance(parentFileName);
    if (advance.kind !== "next") {
      break;
    }

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

function findParentModel(ast: JsonDocumentNode): string | null {
  const parent = objectMembers(ast.body).find(member => memberName(member) === "parent");
  return stringValue(parent?.value) ?? null;
}

export function modelSourceForFile(fileName: string): string {
  return modelSourceForFileName(fileName);
}
