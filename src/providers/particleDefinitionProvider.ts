import { TextDocument, Position, Location } from "vscode";
import { generateRedirectPath } from "../utils/pathGenerator";
import { isInArea } from "../utils/locationChecker";
import { arrayElements, memberName, objectMembers, parseJsonAst, stringValue } from "../utils/jsonAst";

export default (document: TextDocument, position: Position) => {
  const ast = parseJsonAst(document.getText());
  if (!ast) {
    return null;
  }

  const line: number = position.line + 1;
  const character: number = position.character + 1;

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) === "textures" && isInArea(line, character, item.value?.loc)) {
      for (const texture of arrayElements(item.value)) {
        if (isInArea(line, character, texture.loc)) {
          const texturePath = stringValue(texture);
          if (texturePath) {
            const path = generateRedirectPath(texturePath, document, "textures/particle", "particles", "png");
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
