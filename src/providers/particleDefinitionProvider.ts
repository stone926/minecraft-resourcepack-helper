import { TextDocument, Position, Location } from "vscode";
import { generateRedirectPath } from "../utils/pathGenerator";
import { isInArea } from "../utils/locationChecker";
import { loadavg } from "os";
const { parse } = require("@humanwhocodes/momoa");

export default (document: TextDocument, position: Position) => {
  const ast = parse(document.getText());
  const line: number = position.line + 1;
  const character: number = position.character + 1;
  if (ast?.body?.members !== null) {
    for (let item of ast.body.members) {
      if (item.name.value === "textures") {
        if (isInArea(line, character, item.value.loc)) {
          let textureList = item.value.elements;
          if (textureList !== null) {
            for (let texture of textureList) {
              if (isInArea(line,character,texture.loc)) {
                let path = generateRedirectPath(texture.value, document, "textures\\particle", "particles", "png");
                if (path !== null) {
                  return new Location(path, new Position(0, 0));
                }
              }
            }
          }
        }
      }
    }
  }
};