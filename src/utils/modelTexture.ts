import { modelSourceForFile } from "../services/modelParentChain";
import {
  workspaceResourceCache,
  type CachedTextureVariableDefinition,
  type ResourceConfiguration
} from "../services/workspaceResourceCache";
import { JsonDocumentNode } from "./jsonAst";

export { modelSourceForFile };
export type { CachedTextureVariableDefinition };

interface ModelDocument {
  fileName: string;
  getText(): string;
}

export class TextureVariableDefinitionResolver {
  private readonly ast: JsonDocumentNode;
  private readonly document: ModelDocument;

  constructor(
    ast: JsonDocumentNode,
    document: ModelDocument,
    private readonly configuration: () => ResourceConfiguration,
    private readonly source = modelSourceForFile(document.fileName)
  ) {
    this.ast = ast;
    this.document = document;
  }

  resolve(textureReference: string): CachedTextureVariableDefinition | null {
    if (!textureReference.startsWith("#")) {
      return null;
    }

    const variableName = textureReference.slice(1);
    return workspaceResourceCache
      .getModelTextureVariableDefinitions(this.document, this.ast, this.configuration(), this.source)
      .get(variableName) ?? null;
  }

  has(textureReference: string): boolean {
    return this.resolve(textureReference) !== null;
  }
}

export function createTextureVariableDefinitionResolver(
  ast: JsonDocumentNode,
  document: ModelDocument,
  configuration: () => ResourceConfiguration,
  source = modelSourceForFile(document.fileName)
): TextureVariableDefinitionResolver {
  return new TextureVariableDefinitionResolver(ast, document, configuration, source);
}

export function resolveTextureVariableDefinition(
  ast: JsonDocumentNode,
  document: ModelDocument,
  textureReference: string,
  configuration: () => ResourceConfiguration,
  source = modelSourceForFile(document.fileName)
): CachedTextureVariableDefinition | null {
  return createTextureVariableDefinitionResolver(ast, document, configuration, source).resolve(textureReference);
}
