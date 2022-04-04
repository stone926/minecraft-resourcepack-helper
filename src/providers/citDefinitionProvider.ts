import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export default (document: vscode.TextDocument, position: vscode.Position) => {
  const lineText = document.lineAt(position.line).text.trim();
  let value = lineText.slice(lineText.indexOf("=") + 1, lineText.length);
  if (new RegExp(`[\s\S]*=${value}`).test(lineText)) {
    const key = lineText.slice(0, lineText.indexOf("="));
    if (/[texture|model].?[\s\S]*/.test(key)) {
      let texturePath = "";
      value = value.replace(/minecraft:/g, "");

      if (value.includes("/")) {
        if (!value.startsWith("assets")) {
          let type="";
          if (/texture.?[\s\S]*/.test(key)) { type = "textures"; }
          else if (/model.?[\s\S]*/.test(key)) { type = "models"; }
          value = path.join("assets/minecraft", type,value);
        }
        // if (value.startsWith("assets")) {
        const folders = vscode.workspace.workspaceFolders;
        let rootPath;
        if (folders !== undefined) {
          rootPath = folders[0];
          texturePath = path.join(rootPath.uri.fsPath, value);
          console.log(texturePath)
        }
        // }
      } else {
        texturePath = path.join(path.dirname(document.fileName), value);
      }

      if (path.extname(texturePath) === "") {
        if (/texture.?[\s\S]*/.test(key)) { texturePath += ".png"; }
        else if (/model.?[\s\S]*/.test(key)) { texturePath += ".json"; }
      }
      if (fs.existsSync(texturePath)) {
        return new vscode.Location(vscode.Uri.file(texturePath), new vscode.Position(0, 0));
      }
    }
  }
};

