import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultPackPng, errorMsg, promptMsg, defaultPackAttributes, getPackMcmeta } from "./constants";
const S = require("string");

export default async function createNewResourcePackRoot() {
  if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders[0]) {
    vscode.window.showErrorMessage("McResHelper: No open folder, failed to create resource pack");
    return;
  }
  const folders = vscode.workspace.workspaceFolders;
  let namespace = <string>await vscode.window.showInputBox({
    prompt: promptMsg.namespace,
    value: defaultPackAttributes.namespace,
    validateInput(input: string) {
      if (S(input).isEmpty()) {
        return errorMsg.emptyInput;
      }
    }
  });
  let packFormat = await vscode.window.showInputBox({
    prompt: promptMsg.packFormat,
    value: defaultPackAttributes.packFormat,
    validateInput(input: string) {
      if (!S(input).isNumeric()) {
        return errorMsg.nanInput;
      }
    }
  });
  let description = await vscode.window.showInputBox({
    prompt: promptMsg.description
  });
  const packMcmeta = getPackMcmeta(packFormat, description);
  const packPath = path.join(folders[0].uri.fsPath);
  fs.writeFileSync(path.join(packPath, "pack.mcmeta"), packMcmeta);
  fs.writeFileSync(path.join(packPath, "pack.png"), Buffer.from(defaultPackPng, "base64"));
  fs.mkdirSync(path.join(packPath, "assets"));
  fs.mkdirSync(path.join(packPath, "assets", namespace));
  fs.mkdirSync(path.join(packPath, "assets", namespace, "blockstates"));
  fs.mkdirSync(path.join(packPath, "assets", namespace, "models"));
  fs.mkdirSync(path.join(packPath, "assets", namespace, "models", "block"));
  fs.mkdirSync(path.join(packPath, "assets", namespace, "models", "item"));
  fs.mkdirSync(path.join(packPath, "assets", namespace, "textures"));
  fs.mkdirSync(path.join(packPath, "assets", namespace, "textures", "block"));
  fs.mkdirSync(path.join(packPath, "assets", namespace, "textures", "item"));
}