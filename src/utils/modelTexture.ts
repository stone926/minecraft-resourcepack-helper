import { Location, Position, TextDocument } from "vscode";
import { JsonDocumentNode, memberName, objectMembers } from "./jsonAst";

export function resolveTextureVariableDefinition(ast: JsonDocumentNode, document: TextDocument, textureReference: string): Location | null {
  if (!textureReference.startsWith("#")) {
    return null;
  }

  const variableName = textureReference.slice(1);
  const textures = objectMembers(ast?.body).find(member => memberName(member) === "textures");
  const definition = objectMembers(textures?.value).find(member => memberName(member) === variableName);
  const location = definition?.name?.loc ?? definition?.loc;

  if (!location) {
    return null;
  }

  return new Location(document.uri, new Position(location.start.line - 1, location.start.column - 1));
}
