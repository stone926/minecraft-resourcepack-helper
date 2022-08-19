import * as path from "node:path";
import * as fs from "node:fs";
import { TextDocument, Uri, workspace } from "vscode";

export function generateRedirectPath(modelPath: string, document: TextDocument, target: string, source: string,targetFileExtension: string): Uri | null {
  const match = new RegExp(`(.+)\\\\${source}.+json$`).exec(document.fileName);
  if (modelPath.startsWith("minecraft:")) {
    modelPath = modelPath.replace("minecraft:", "");
  }
  if (!modelPath.endsWith(`.${targetFileExtension}`)) {
    modelPath += `.${targetFileExtension}`;
  }
  if (match !== null && match.length === 2) {
    const pathInCurrentFolder = path.join(match[1], target, modelPath);
    const defaultPath = workspace.getConfiguration().get("McResHelper.defaultMcAssetsPath");
    if (fs.existsSync(pathInCurrentFolder)) {
      return Uri.file(pathInCurrentFolder);
    } else if (defaultPath !== null) {
      const pathInDefaultFolder = path.join(<string>defaultPath, `minecraft/${target}`, modelPath);
      if (fs.existsSync(pathInDefaultFolder)) {
        return Uri.file(pathInDefaultFolder);
      }
    }
  }
  return null;
}