import { TextDocument, Position, Location } from "vscode";
import { generateRedirectPath } from "../utils/pathGenerator";
const { parse } = require("@humanwhocodes/momoa");

export default (document: TextDocument, position: Position) => {
  const ast = parse(document.getText());
  const line: number = position.line + 1;
  const character: number = position.character + 1;
  if (ast?.body?.members !== null) {
    for (let item of ast.body.members) {
      if (item.name.value === "parent") {
        const startLine: number = item.value.loc.start.line;
        const endLine: number = item.value.loc.end.line;
        const startColumn: number = item.value.loc.start.column;
        const endColumn: number = item.value.loc.end.column;
        if (startLine <= line && line <= endLine && startColumn <= character && character <= endColumn) {
          let modelPath = item.value.value;
          let path = generateRedirectPath(modelPath, document, "models", "models\\\\item", "json");
          if (path !== null) {
            return new Location(path, new Position(0, 0));
          }
        }
      } else if (item.name.value === "textures") {
        if (item?.value?.members !== null) {
          for (let item2 of item.value.members) {
            let startPosition: Position = new Position(item2.loc.start.line - 1, item2.loc.start.column - 1);
            let endPosition: Position = new Position(item2.loc.end.line - 1, item2.loc.end.column - 1);
            if (position.isAfterOrEqual(startPosition) && position.isBeforeOrEqual(endPosition)) {
              let modelPath = item2.value.value;
              let path = generateRedirectPath(modelPath, document, "textures", "models\\\\item", "png");
              if (path !== null) {
                return new Location(path, new Position(0, 0));
              }
            }
          }
        }
      } else if (item.name.value === "overrides") {
        if (item?.value?.elements !== null) {
          for (let item2 of item.value.elements) {
            let startPosition: Position = new Position(item2.loc.start.line - 1, item2.loc.start.column - 1);
            let endPosition: Position = new Position(item2.loc.end.line - 1, item2.loc.end.column - 1);
            if (position.isAfterOrEqual(startPosition) && position.isBeforeOrEqual(endPosition)) {
              if (item2?.members !== null) {
                for (let item3 of item2.members) {
                  if (item3?.name?.value === "model") {
                    let startPosition: Position = new Position(item3.loc.start.line - 1, item3.loc.start.column - 1);
                    let endPosition: Position = new Position(item3.loc.end.line - 1, item3.loc.end.column - 1);
                    if (position.isAfterOrEqual(startPosition) && position.isBeforeOrEqual(endPosition)) {
                      let modelPath = item3.value.value;
                      let path = generateRedirectPath(modelPath, document, "models", "models\\\\item", "json");
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
      }
    }
  }
  return null;
};