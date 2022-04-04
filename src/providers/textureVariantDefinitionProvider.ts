import * as vscode from 'vscode';
import * as path from 'path';

export default (document: vscode.TextDocument, position: vscode.Position) => {
  const fileName = document.fileName;
  const filePath = path.dirname(fileName);
  // document.
  let word = document.getText(document.getWordRangeAtPosition(position));
  word = word.replace(/"/g, "");
  // console.log("filepath: " + filePath + " " + /[\s\S]*models[\s\S]*/.test(filePath));
  // console.log("word: " + word + " " + /^#[\s\S]*/.test(word));
  if (/[\s\S]*models[\s\S]*/.test(filePath) && /^#[\s\S]*/.test(word)) {
    const fileJson = JSON.parse(document.getText());
    console.log(fileJson);
    if (fileJson.textures !== null) {
      let texture = fileJson.textures[word.replace(/#/g, "")];
      console.log(texture);
    }
    return new vscode.Location(vscode.Uri.file(fileName), new vscode.Position(0, 0));
  }
};