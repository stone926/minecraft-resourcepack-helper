import { TextDocument, Position, Location, InlineValueEvaluatableExpression } from "vscode";
import { generateRedirectPath } from "../utils/pathGenerator";
import { isInArea } from "../utils/locationChecker";
const { parse } = require("@humanwhocodes/momoa");

export default (document: TextDocument, position: Position) => {
  const ast = parse(document.getText());
  const line: number = position.line + 1;
  const character: number = position.character + 1;
  if (ast?.body?.members !== null) {
    for (let item of ast.body.members) {
      if (item.name.value === "parent") {
        if (isInArea(line,character,item.value.loc)) {
          let modelPath = item.value.value;
          let path = generateRedirectPath(modelPath, document, "models", "models\\\\block", "json");
          if (path !== null) {
            return new Location(path, new Position(0, 0));
          }
        }
      } else if (item.name.value === "textures") {
        if (item?.value?.members !== null) {
          for (let item2 of item.value.members) {
            if (isInArea(line,character,item2.loc)) {
              let modelPath = item2.value.value;
              let path = generateRedirectPath(modelPath, document, "textures", "models\\\\block", "png");
              if (path !== null) {
                return new Location(path, new Position(0, 0));
              }
            }
          }
        }
      }
    }
  }
};