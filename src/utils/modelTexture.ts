import * as fs from "node:fs";
import * as path from "node:path";
import { Location, Position, TextDocument, Uri } from "vscode";
import { generateRedirectPath } from "./pathGenerator";
import { JsonDocumentNode, memberName, objectMembers, parseJsonAst, stringValue } from "./jsonAst";

interface ModelDocument {
  fileName: string;
  uri: Uri;
  getText(): string;
}

interface LoadedModelDocument {
  ast: JsonDocumentNode;
  document: ModelDocument;
  source: string;
}

export class TextureVariableDefinitionResolver {
  private readonly parentDocuments = new Map<string, LoadedModelDocument | null>();
  private readonly ast: JsonDocumentNode;
  private readonly document: ModelDocument;
  private readonly source: string;

  constructor(
    ast: JsonDocumentNode,
    document: ModelDocument,
    source = modelSourceForFile(document.fileName)
  ) {
    this.ast = ast;
    this.document = document;
    this.source = source;
  }

  resolve(textureReference: string): Location | null {
    if (!textureReference.startsWith("#")) {
      return null;
    }

    return this.resolveTextureVariable(
      this.ast,
      this.document,
      textureReference.slice(1),
      this.source,
      new Set<string>([modelUriKey(this.document.uri)])
    );
  }

  has(textureReference: string): boolean {
    return this.resolve(textureReference) !== null;
  }

  private resolveTextureVariable(
    ast: JsonDocumentNode,
    document: ModelDocument,
    variableName: string,
    source: string,
    visited: Set<string>
  ): Location | null {
    const localDefinition = findLocalTextureVariable(ast, document.uri, variableName);
    if (localDefinition) {
      return localDefinition;
    }

    const parentValue = findParentModel(ast);
    if (!parentValue) {
      return null;
    }

    const parentUri = generateRedirectPath(parentValue, document, "models", source, "json");
    if (!parentUri) {
      return null;
    }

    const parentKey = modelUriKey(parentUri);
    if (visited.has(parentKey)) {
      return null;
    }
    visited.add(parentKey);

    const parentDocument = this.loadParentDocument(parentUri);
    if (!parentDocument) {
      return null;
    }

    return this.resolveTextureVariable(
      parentDocument.ast,
      parentDocument.document,
      variableName,
      parentDocument.source,
      visited
    );
  }

  private loadParentDocument(uri: Uri): LoadedModelDocument | null {
    const key = modelUriKey(uri);
    if (this.parentDocuments.has(key)) {
      return this.parentDocuments.get(key) ?? null;
    }

    let parentText: string;
    try {
      parentText = fs.readFileSync(uri.fsPath, "utf8");
    } catch {
      this.parentDocuments.set(key, null);
      return null;
    }

    const parentAst = parseJsonAst(parentText);
    if (!parentAst) {
      this.parentDocuments.set(key, null);
      return null;
    }

    const document = {
      fileName: uri.fsPath,
      uri,
      getText: () => parentText
    };
    const loadedDocument = {
      ast: parentAst,
      document,
      source: modelSourceForFile(uri.fsPath)
    };

    this.parentDocuments.set(key, loadedDocument);
    return loadedDocument;
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

function findLocalTextureVariable(ast: JsonDocumentNode, uri: Uri, variableName: string): Location | null {
  const textures = objectMembers(ast?.body).find(member => memberName(member) === "textures");
  const definition = objectMembers(textures?.value).find(member => memberName(member) === variableName);
  const location = definition?.name?.loc ?? definition?.loc;

  if (!location) {
    return null;
  }

  return new Location(uri, new Position(location.start.line - 1, location.start.column - 1));
}

function findParentModel(ast: JsonDocumentNode): string | null {
  const parent = objectMembers(ast.body).find(member => memberName(member) === "parent");
  return stringValue(parent?.value) ?? null;
}

function modelUriKey(uri: Uri): string {
  const normalizedPath = path.normalize(uri.fsPath);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}
