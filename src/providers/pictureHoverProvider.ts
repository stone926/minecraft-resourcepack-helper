import * as vscode from "vscode";
import * as fs from 'fs';
import * as path from 'path';

/**
 * @deprecated
 */
export default (document: vscode.TextDocument, position: vscode.Position) => {
  const defaultPath = vscode.workspace.getConfiguration().get("McResHelper.defaultMcAssetsPath")

  const blockMatch = /(.+)\\models\\(block|item).+json$/.exec(document.fileName)
  if (blockMatch) {
    const word = document.getText(document.getWordRangeAtPosition(position))
    const json = document.getText()
    // textures
    if (new RegExp(`"textures"\\s*?:\\s*?\\{[\\s\\S]*?${word.replace('/', '\\/')}[\\s\\S]*?\\}`, 'gm').test(json)) {
      const name = word.startsWith('"minecraft:') ? word.slice(11, -1) : word.slice(1, -1)
      const distName = `${blockMatch[1]}/textures/${name}.png`;
      if (fs.existsSync(distName)) {
        const uri = vscode.Uri.file(distName);
        let markdown = new vscode.MarkdownString(
          `<img src="${uri}"/><img src="${uri}" width="160px" height="160px" />`
        );
        markdown.supportHtml = true;
        return new vscode.Hover(markdown);
      } else if (defaultPath !== null) {
        const join = path.join(<string>defaultPath, "minecraft", `/textures/${name}.png`)
        if (fs.existsSync(join)) {
          const uri = vscode.Uri.file(join);
          let markdown = new vscode.MarkdownString(
            `<img src="${uri}" /><img src="${uri}" width="160px" height="160px" />`
          );
          markdown.supportHtml = true;
          return new vscode.Hover(markdown);
        }
      }
    }
  }
};