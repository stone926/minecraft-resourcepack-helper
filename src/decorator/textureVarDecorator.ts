import * as vscode from "vscode";
const { parse } = require("@humanwhocodes/momoa");

const tipColor = <string>vscode.workspace.getConfiguration().get("McResHelper.TipColorForUndefinedTextureVariables");
const decorationType = vscode.window.createTextEditorDecorationType({
  color: tipColor
});

export default function applyDecoration(editor: vscode.TextEditor) {
  if (editor.document.languageId === "json") {
    const documentPath = editor.document.uri.fsPath;
    if (/(.+)\\models\\block.+json$/.test(documentPath)) {
      const ast = parse(editor.document.getText(), { tokens: true });
      let texturesAst: any = null;
      let ranges: vscode.Range[] = [];
      for (let item1 of ast.body.members) {
        if (item1.name.value === "textures") {
          texturesAst = item1;
        } else if (item1.name.value === "elements" && item1.value.type === "Array") {
          for (let item2 of item1.value.elements) {
            for (let item3 of item2.members) {
              if (item3.name.value === "faces" && item3.value.type === "Object") {
                for (let face of item3.value.members) {
                  for (let key of face.value.members) {
                    if (key.name.value === "texture") {
                      if (key.value.type === "String" && (<string>(key.value.value)).startsWith("#")) {
                        let noDefinition: boolean = true;
                        if (texturesAst !== null) {
                          for (let texture of texturesAst.value.members) {
                            if (texture.name.value === (<string>(key.value.value)).replace("#","")) {
                              noDefinition = false;
                            }
                          }
                        }
                        if (texturesAst === null || noDefinition) {
                          ranges.push(new vscode.Range(new vscode.Position(key.value.loc.start.line - 1, key.value.loc.start.column - 1), new vscode.Position(key.value.loc.end.line - 1, key.value.loc.end.column - 1)));
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
      editor.setDecorations(decorationType, ranges);
    }
  }
}