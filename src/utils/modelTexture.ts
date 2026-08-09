import { modelSourceForFileName } from "../resources/resourceSurfaceRegistry";
import {
  arrayElements,
  memberName,
  objectMembers,
  stringValue,
  type JsonAstNode,
  JsonDocumentNode
} from "./jsonAst";
import type { ResourceConfiguration } from "./resourceConfigurationTypes";
import { ScopedRegistry, type ScopedRegistration } from "./scopedRegistry";

interface ModelDocument {
  fileName: string;
  getText(): string;
}

export interface ModelTextureVariableDefinition {
  fileName: string;
  line: number;
  character: number;
}

export interface ModelTextureResolutionHost {
  getModelTextureVariableDefinitions(
    document: ModelDocument,
    ast: JsonDocumentNode,
    configuration: ResourceConfiguration,
    source?: string
  ): ReadonlyMap<string, ModelTextureVariableDefinition>;
}

const defaultHostRegistry = new ScopedRegistry<"default", ModelTextureResolutionHost>();

export function registerDefaultModelTextureResolutionHost(
  host: ModelTextureResolutionHost
): ScopedRegistration {
  return defaultHostRegistry.register("default", host);
}

export class TextureVariableDefinitionResolver {
  constructor(
    private readonly ast: JsonDocumentNode,
    private readonly document: ModelDocument,
    private readonly configuration: () => ResourceConfiguration,
    private readonly source: string = modelSourceForFileName(document.fileName),
    private readonly host?: ModelTextureResolutionHost
  ) {}

  resolve(textureReference: string): ModelTextureVariableDefinition | null {
    if (!textureReference.startsWith("#")) {
      return null;
    }

    const variableName = textureReference.slice(1);
    return this.getHost()
      .getModelTextureVariableDefinitions(this.document, this.ast, this.configuration(), this.source)
      .get(variableName) ?? null;
  }

  has(textureReference: string): boolean {
    return this.resolve(textureReference) !== null;
  }

  private getHost(): ModelTextureResolutionHost {
    const host = this.host ?? defaultHostRegistry.get("default");
    if (!host) {
      throw new Error("Model texture resolution host has not been registered.");
    }
    return host;
  }
}

export function createTextureVariableDefinitionResolver(
  ast: JsonDocumentNode,
  document: ModelDocument,
  configuration: () => ResourceConfiguration,
  source: string = modelSourceForFileName(document.fileName),
  host?: ModelTextureResolutionHost
): TextureVariableDefinitionResolver {
  return new TextureVariableDefinitionResolver(ast, document, configuration, source, host);
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
          const texture = objectMembers(face.value).find(faceMember =>
            memberName(faceMember) === "texture"
          );
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
