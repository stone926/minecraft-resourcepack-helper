import * as fs from "node:fs";
import { Location, Position, TextDocument, Uri } from "vscode";
import { generateRedirectPath } from "./pathGenerator";
import { JsonDocumentNode, memberName, objectMembers, parseJsonAst, stringValue } from "./jsonAst";

interface ModelDocument {
  fileName: string;
  uri: Uri;
  getText(): string;
}

export function resolveTextureVariableDefinition(
  ast: JsonDocumentNode,
  document: TextDocument,
  textureReference: string,
  source = modelSourceForFile(document.fileName)
): Location | null {
  if (!textureReference.startsWith("#")) {
    return null;
  }

  return resolveTextureVariable(ast, document, textureReference.slice(1), source, new Set<string>());
}

export function hasTextureVariableDefinition(
  ast: JsonDocumentNode,
  document: TextDocument,
  textureReference: string,
  source = modelSourceForFile(document.fileName)
): boolean {
  return resolveTextureVariableDefinition(ast, document, textureReference, source) !== null;
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

function resolveTextureVariable(
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

  const parentUri = generateRedirectPath(parentValue, document as TextDocument, "models", source, "json");
  if (!parentUri || visited.has(parentUri.fsPath)) {
    return null;
  }

  visited.add(parentUri.fsPath);

  let parentText: string;
  try {
    parentText = fs.readFileSync(parentUri.fsPath, "utf8");
  } catch {
    return null;
  }

  const parentAst = parseJsonAst(parentText);
  if (!parentAst) {
    return null;
  }

  return resolveTextureVariable(parentAst, {
    fileName: parentUri.fsPath,
    uri: parentUri,
    getText: () => parentText
  }, variableName, modelSourceForFile(parentUri.fsPath), visited);
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
