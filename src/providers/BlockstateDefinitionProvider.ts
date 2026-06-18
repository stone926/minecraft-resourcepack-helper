import { Definition, DefinitionLink, Location, Position, ProviderResult, TextDocument } from 'vscode';
import { generateRedirectPath } from "../utils/pathGenerator";
import { isInArea } from '../utils/locationChecker';
import { arrayElements, JsonAstNode, JsonMemberNode, memberName, objectMembers, parseJsonAst, stringValue } from '../utils/jsonAst';

export default (document: TextDocument, position: Position) => {
  const ast = parseJsonAst(document.getText());
  if (!ast) {
    return null;
  }

  const line: number = position.line + 1;
  const character: number = position.character + 1;

  if (ast.type === "Document") {
    for (const item of objectMembers(ast.body)) {
      if (memberName(item) === "variants") {
        return processVariants(item, line, character, document);
      } else if (memberName(item) === "multipart") {
        return processMultipart(item, line, character, document);
      }
    }
  }

  return null;
};

function processVariants(variants: JsonMemberNode, line: number, character: number, document: TextDocument): ProviderResult<Definition | DefinitionLink[]> {
  for (const variantEntry of objectMembers(variants?.value)) {
    if (isInArea(line, character, variantEntry.loc)) {
      if (variantEntry.value?.type === "Object") {
        const location = resolveModelProperty(variantEntry.value, line, character, document);
        if (location) {
          return location;
        }
      } else if (variantEntry.value?.type === "Array") {
        for (const modelDirection of arrayElements(variantEntry.value)) {
          if (isInArea(line, character, modelDirection.loc)) {
            const location = resolveModelProperty(modelDirection, line, character, document);
            if (location) {
              return location;
            }
          }
        }
      }
    }
  }
  return null;
}

function processMultipart(multipart: JsonMemberNode, line: number, character: number, document: TextDocument): ProviderResult<Definition | DefinitionLink[]> {
  for (const multipartEntry of arrayElements(multipart?.value)) {
    if (isInArea(line, character, multipartEntry.loc)) {
      for (const applyEntry of objectMembers(multipartEntry)) {
        if (memberName(applyEntry) === "apply" && isInArea(line, character, applyEntry.loc)) {
          if (applyEntry.value?.type === "Object") {
            const location = resolveModelProperty(applyEntry.value, line, character, document);
            if (location) {
              return location;
            }
          } else if (applyEntry.value?.type === "Array") {
            for (const modelDirection of arrayElements(applyEntry.value)) {
              if (isInArea(line, character, modelDirection.loc)) {
                const location = resolveModelProperty(modelDirection, line, character, document);
                if (location) {
                  return location;
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

function resolveModelProperty(node: JsonAstNode, line: number, character: number, document: TextDocument): Location | null {
  for (const modelEntry of objectMembers(node)) {
    if (memberName(modelEntry) === "model" && isInArea(line, character, modelEntry.value?.loc)) {
      const modelPath = stringValue(modelEntry.value);
      if (!modelPath) {
        return null;
      }

      const targetPath = generateRedirectPath(modelPath, document, "models", "blockstates", "json");
      return targetPath ? new Location(targetPath, new Position(0, 0)) : null;
    }
  }

  return null;
}
