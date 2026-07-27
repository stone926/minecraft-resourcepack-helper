import {
  modelSourceForFile,
  type CachedTextureVariableDefinition
} from "../services/modelParentChain";
import type { ResourceConfiguration } from "../services/resourceCacheTypes";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import {
  arrayElements,
  memberName,
  objectMembers,
  stringValue,
  type JsonAstNode,
  JsonDocumentNode
} from "./jsonAst";

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

export interface ModelTextureVariableReference {
  node: JsonAstNode;
  /** Raw reference including the leading `#`. */
  value: string;
}

/** `#variable` reference value nodes from `textures` and `elements[].faces.*.texture`. */
export function collectTextureVariableReferenceNodes(
  modelBody: JsonAstNode | null | undefined
): ModelTextureVariableReference[] {
  const references: ModelTextureVariableReference[] = [];
  for (const member of objectMembers(modelBody)) {
    const name = memberName(member);
    if (name === "textures") {
      for (const texture of objectMembers(member.value)) {
        pushTextureVariableReference(references, texture.value);
      }
    } else if (name === "elements") {
      for (const element of arrayElements(member.value)) {
        const faces = objectMembers(element).find(face => memberName(face) === "faces");
        for (const face of objectMembers(faces?.value)) {
          const texture = objectMembers(face.value).find(faceMember => memberName(faceMember) === "texture");
          pushTextureVariableReference(references, texture?.value);
        }
      }
    }
  }
  return references;
}

function pushTextureVariableReference(
  references: ModelTextureVariableReference[],
  node: JsonAstNode | null | undefined
): void {
  const value = node ? stringValue(node) : undefined;
  if (node && value?.startsWith("#")) {
    references.push({ node, value });
  }
}
