import { Definition, DefinitionLink, Location, Position, ProviderResult, TextDocument } from 'vscode';
import { generateRedirectPath } from "../utils/pathGenerator";
import { isInArea } from '../utils/locationChecker';
const { parse } = require("@humanwhocodes/momoa");

export default (document: TextDocument, position: Position) => {
  const ast = parse(document.getText());
  const line: number = position.line + 1;
  const character: number = position.character + 1;
  if (ast.type === "Document") {
    if (ast.body.type === "Object" && ast.body.members !== null) {
      for (let item of ast.body.members) {
        if (item.name.value === "variants") {
          return processVariants(item, line, character, document);
        } else if (item.name.value === "multipart") {
          return processMultipart(item, line, character, document);
        }
      }
    }
  }
};

function processVariants(variants, line: number, character: number, document: TextDocument): ProviderResult<Definition | DefinitionLink[]> {
  if (variants?.value.members !== null) {
    for (let item of variants.value.members) {
      if (isInArea(line, character, item.loc)) {
        if (item?.value?.members !== null) {
          if (item.value.type === "Object") {
            for (let item2 of item.value.members) {
              if (item2?.name?.value === "model") {
                if (isInArea(line, character, item2.value.loc)) {
                  let modelPath = item2.value.value;
                  console.log(line, character, item2.value.loc)
                  let path = generateRedirectPath(modelPath, document, "models", "blockstates", "json");
                  if (path !== null) { return new Location(path, new Position(0, 0)); }
                }
              }
            }
          } else if (item.value.type === "Array") {
            for (let modelDirection of item.value.elements) {
              if (isInArea(line, character, modelDirection.loc)) {
                for (let modelEntry of modelDirection.members) {
                  if (modelEntry?.name?.value === "model") {
                    if (isInArea(line, character, modelEntry.value.loc)) {
                      let modelPath = modelEntry.value.value;
                      let path = generateRedirectPath(modelPath, document, "models", "blockstates", "json");
                      if (path !== null) { return new Location(path, new Position(0, 0)); }
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
}

function processMultipart(multipart, line: number, character: number, document: TextDocument): ProviderResult<Definition | DefinitionLink[]> {
  if (multipart?.value?.elements !== null) {
    for (let item of multipart.value.elements) {
      if (isInArea(line, character, item.loc)) {
        if (item.members !== null) {
          for (let item2 of item.members) {
            if (item2?.name?.value === "apply" && item2?.value?.members !== null) {
              if (isInArea(line, character, item2.loc)) {
                if (item2.value.type === "Object") {
                  for (let item3 of item2.value.members) {
                    if (item3?.name?.value === "model") {
                      if (isInArea(line, character, item3.value.loc)) {
                        let path = generateRedirectPath(item3.value.value, document, "models", "blockstates", "json");
                        if (path !== null) {
                          return new Location(path, new Position(0, 0));
                        }
                      }
                    }
                  }
                } else if (item2.value.type === "Array") {
                  for (let modelDirection of item2.value.elements) {
                    if (isInArea(line, character, modelDirection.loc)) {
                      for (let modelEntry of modelDirection.members) {
                        if (modelEntry?.name?.value === "model") {
                          if (isInArea(line, character, modelEntry.value.loc)) {
                            let path = generateRedirectPath(modelEntry.value.value, document, "models", "blockstates", "json");
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
      }
    }
  }
  return null;
}