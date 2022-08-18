import path = require("path");
import { TextDocument, Uri, workspace } from "vscode";
import * as fs from "fs";

export function generateRedirectPath(modelPath: string, document: TextDocument, type: string): Uri | null {
  const match = /(.+)\\blockstates.+json$/.exec(document.fileName);
  if (modelPath.startsWith("minecraft:")) {
    modelPath = modelPath.replace("minecraft:", "");
  }
  if (!modelPath.endsWith(".json")) {
    modelPath += ".json"
  }
  if (match !== null && match.length === 2) {
    const pathInCurrentFolder = path.join(match[1], type, modelPath);
    const defaultPath = workspace.getConfiguration().get("McResHelper.defaultMcAssetsPath");
    if (fs.existsSync(pathInCurrentFolder)) {
      return Uri.file(pathInCurrentFolder);
    } else if (defaultPath !== null) {
      const pathInDefaultFolder = path.join(<string>defaultPath, `minecraft/${type}`, modelPath);
      if (fs.existsSync(pathInDefaultFolder)) {
        return Uri.file(pathInDefaultFolder);
      }
    }
  }
  return null;
}