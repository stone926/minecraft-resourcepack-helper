import * as vscode from 'vscode';
import { arrayElements, memberName, objectMembers, parseJsonAst, stringValue } from '../utils/jsonAst';
import { isInArea } from '../utils/locationChecker';
import { resolveTextureVariableDefinition } from '../utils/modelTexture';

export default (document: vscode.TextDocument, position: vscode.Position) => {
  const ast = parseJsonAst(document.getText());
  if (!ast) {
    return null;
  }

  const line = position.line + 1;
  const character = position.character + 1;
  if (ast.type === 'Document') {
    const modelElements = objectMembers(ast.body).find(member => memberName(member) === 'elements');
    if (modelElements && isInArea(line, character, modelElements.loc)) {
      const element = arrayElements(modelElements.value).find(modelItem => isInArea(line, character, modelItem.loc));
      const modelFaces = objectMembers(element).find(elementItem => memberName(elementItem) === 'faces');

      if (modelFaces && isInArea(line, character, modelFaces.loc)) {
        const modelFace = objectMembers(modelFaces.value).find(faceItem => isInArea(line, character, faceItem.loc));

        if (modelFace) {
          const textureEntry = objectMembers(modelFace.value).find(couple => memberName(couple) === 'texture' && isInArea(line, character, couple.value?.loc));
          const texture = stringValue(textureEntry?.value);

          if (texture) {
            return resolveTextureVariableDefinition(ast, document, texture);
          }
        }
      }
    }
  }

  return null;
};
