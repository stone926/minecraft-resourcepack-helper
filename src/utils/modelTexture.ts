import { Location, Position, TextDocument, Uri, workspace } from "vscode";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { JsonDocumentNode } from "./jsonAst";

interface ModelDocument {
  fileName: string;
  uri: Uri;
  getText(): string;
}

export class TextureVariableDefinitionResolver {
  private readonly ast: JsonDocumentNode;
  private readonly document: ModelDocument;

  constructor(
    ast: JsonDocumentNode,
    document: ModelDocument,
    private readonly source = modelSourceForFile(document.fileName)
  ) {
    this.ast = ast;
    this.document = document;
  }

  resolve(textureReference: string): Location | null {
    if (!textureReference.startsWith("#")) {
      return null;
    }

    const variableName = textureReference.slice(1);
    const definition = workspaceResourceCache
      .getModelTextureVariableDefinitions(this.document, this.ast, getResourceConfiguration(), this.source)
      .get(variableName);
    if (!definition) {
      return null;
    }

    const uri = isSamePath(definition.fileName, this.document.fileName)
      ? this.document.uri
      : Uri.file(definition.fileName);
    return new Location(uri, new Position(definition.line, definition.character));
  }

  has(textureReference: string): boolean {
    return this.resolve(textureReference) !== null;
  }
}

export function createTextureVariableDefinitionResolver(
  ast: JsonDocumentNode,
  document: ModelDocument,
  source = modelSourceForFile(document.fileName)
): TextureVariableDefinitionResolver {
  return new TextureVariableDefinitionResolver(ast, document, source);
}

export function resolveTextureVariableDefinition(
  ast: JsonDocumentNode,
  document: TextDocument,
  textureReference: string,
  source = modelSourceForFile(document.fileName)
): Location | null {
  return createTextureVariableDefinitionResolver(ast, document, source).resolve(textureReference);
}

export function hasTextureVariableDefinition(
  ast: JsonDocumentNode,
  document: TextDocument,
  textureReference: string,
  source = modelSourceForFile(document.fileName)
): boolean {
  return createTextureVariableDefinitionResolver(ast, document, source).has(textureReference);
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

function getResourceConfiguration() {
  return {
    defaultAssetsPath: workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath"),
    resourcePackRoots: workspace.getConfiguration().get<string[]>("McResHelper.resourcePackLoadOrder") ?? []
  };
}

function isSamePath(left: string, right: string): boolean {
  const normalizedLeft = Uri.file(left).fsPath;
  const normalizedRight = Uri.file(right).fsPath;
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
