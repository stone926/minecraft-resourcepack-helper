import { TextDocument, Position, Location } from "vscode";
import { generateRedirectPath } from "../utils/pathGenerator";
import { isInArea } from "../utils/locationChecker";
import { memberName, objectMembers, parseJsonAst, stringValue } from "../utils/jsonAst";
import { resolveTextureVariableDefinition } from "../utils/modelTexture";

export default (document: TextDocument, position: Position) => {
  const ast = parseJsonAst(document.getText());
  if (!ast) {
    return null;
  }

  const line: number = position.line + 1;
  const character: number = position.character + 1;

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) === "parent") {
      if (isInArea(line, character, item.value?.loc)) {
        const modelPath = stringValue(item.value);
        if (modelPath) {
          const path = generateRedirectPath(modelPath, document, "models", "models/block", "json");
          if (path !== null) {
            return new Location(path, new Position(0, 0));
          }
        }
      }
    } else if (memberName(item) === "textures") {
      for (const textureEntry of objectMembers(item.value)) {
        if (isInArea(line, character, textureEntry.value?.loc)) {
          const texturePath = stringValue(textureEntry.value);
          if (texturePath) {
            const textureDefinition = resolveTextureVariableDefinition(ast, document, texturePath);
            if (textureDefinition) {
              return textureDefinition;
            }

            const path = generateRedirectPath(texturePath, document, "textures", "models/block", "png");
            if (path !== null) {
              return new Location(path, new Position(0, 0));
            }
          }
        }
      }
    }
  }

  return null;
};
