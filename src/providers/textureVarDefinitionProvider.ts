import * as vscode from 'vscode';
const { parse } = require('@humanwhocodes/momoa');

export default (document: vscode.TextDocument, position: vscode.Position) => {
  const ast = parse(document.getText(), { tokens: true });
  const line = position.line + 1;
  const character = position.character + 1;
  if (ast.type === 'Document') {
    const documentMembers = ast.body.members;
    let modelElements: any = null;
    for (let item of documentMembers) {
      if (item.name.type === 'String' && item.name.value === 'elements') {
        modelElements = item;
        break;
      }
    }
    if (modelElements !== null) {
      const startLine = modelElements.loc.start.line;
      const endLine = modelElements.loc.end.line;
      if (startLine <= line && line <= endLine) {
        let element: any = null;
        for (let modelItem of modelElements.value.elements) {
          const startLine2 = modelItem.loc.start.line;
          const endLine2 = modelItem.loc.end.line;
          if (startLine2 <= line && line <= endLine2) {
            element = modelItem;
            break;
          }
        }
        let modelFaces: any = null;
        for (let elementItem of element.members) {
          if (elementItem.name.value === 'faces') {
            modelFaces = elementItem;
          }
        }
        if (modelFaces !== null) {
          const facesStartLine = modelFaces.loc.start.line;
          const facesEndLine = modelFaces.loc.end.line;
          if (facesStartLine <= line && line <= facesEndLine) {
            let modelFace: any = null;
            for (let facesItem of modelFaces.value.members) {
              const faceStartLine = facesItem.loc.start.line;
              const faceEndLine = facesItem.loc.end.line;
              if (faceStartLine <= line && line <= faceEndLine) {
                modelFace = facesItem;
              }
            }
            if (modelFace !== null) {
              let texture: null | string = null;
              for (let couple of modelFace.value.members) {
                if (couple.name.value === 'texture') {
                  let valueStartLine = couple.value.loc.start.line;
                  let valueEndLine = couple.value.loc.end.line;
                  let valueStartColumn = couple.value.loc.start.column;
                  let valueEndColumn = couple.value.loc.end.column;
                  if (valueStartLine <= line && line <= valueEndLine && valueStartColumn <= character && character <= valueEndColumn) {
                    texture = couple.value.value;
                    break;
                  }
                }
              }
              if (texture !== null) {
                for (let member of ast.body.members) {
                  if (member.name.value === 'textures') {
                    for (let variants of member.value.members) {
                      if (variants.name.value === texture.replace('#', '')) {
                        return new vscode.Location(document.uri, new vscode.Position(variants.loc.start.line - 1, variants.loc.start.column - 1));
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
};