import { Definition, DefinitionLink, Location, Position, ProviderResult, TextDocument } from 'vscode';
import { generateRedirectPath } from '../utils/PathGeneration';
const { parse } = require("@humanwhocodes/momoa");

export default (document: TextDocument, position: Position) => {
  const ast = parse(document.getText(), { tokens: true });
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
  return null;
};

function processVariants(variants, line: number, character: number, document: TextDocument): ProviderResult<Definition | DefinitionLink[]> {
  if (variants?.value.members !== null) {
    for (let item of variants.value.members) {
      const startLine: number = item.loc.start.line;
      const endLine: number = item.loc.end.line;
      if (startLine <= line && line <= endLine) {
        if (item?.value?.members !== null) {
          for (let item2 of item.value.members) {
            if (item2?.name?.value === "model") {
              const startLine: number = item2.value.loc.start.line;
              const endLine: number = item2.value.loc.end.line;
              const startColumn: number = item2.value.loc.start.column;
              const endColumn: number = item2.value.loc.end.column;
              if (startLine <= line && line <= endLine && startColumn <= character && character <= endColumn) {
                let modelPath = item2.value.value;
                let path = generateRedirectPath(modelPath, document, "models");
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
  return null;
}

function processMultipart(multipart, line: number, character: number, document: TextDocument): ProviderResult<Definition | DefinitionLink[]> {
  if (multipart?.value?.elements !== null) {
    for (let item of multipart.value.elements) {
      const startLine: number = item.loc.start.line;
      const endLine: number = item.loc.end.line;
      if (startLine <= line && line <= endLine) {
        if (item.members !== null) {
          for (let item2 of item.members) {
            if (item2?.name?.value === "apply" && item2?.value?.members !== null) {
              const startLine: number = item2.loc.start.line;
              const endLine: number = item2.loc.end.line;
              if (startLine <= line && line <= endLine) {
                for (let item3 of item2.value.members) {
                  if (item3?.name?.value === "model") {
                    const startLine: number = item2.value.loc.start.line;
                    const endLine: number = item2.value.loc.end.line;
                    const startColumn: number = item2.value.loc.start.column;
                    const endColumn: number = item2.value.loc.end.column;
                    if (startLine <= line && line <= endLine && startColumn <= character && character <= endColumn) {
                      let path = generateRedirectPath(item3.value.value, document, "models");
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
}

