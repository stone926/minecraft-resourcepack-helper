import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultPackPng, errorMsg, promptMsg, defaultPackAttributes, getPackMcmeta } from "./constants";

export default async function createNewResourcePack() {
  if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders[0]) {
    vscode.window.showErrorMessage("McResHelper: No open folder, failed to create resource pack");
    return;
  }

  const rootFolder = vscode.workspace.workspaceFolders[0];
  const packName = await vscode.window.showInputBox({
    prompt: promptMsg.packName,
    validateInput(input: string) {
      if (isEmpty(input)) {
        return errorMsg.emptyInput;
      }

      if (fs.existsSync(path.join(rootFolder.uri.fsPath, input))) {
        return errorMsg.folderAlreadyExist;
      }

      return null;
    }
  });
  if (packName === undefined) {
    return;
  }

  const namespace = await vscode.window.showInputBox({
    prompt: promptMsg.namespace,
    value: defaultPackAttributes.namespace,
    validateInput(input: string) {
      return isEmpty(input) ? errorMsg.emptyInput : null;
    }
  });
  if (namespace === undefined) {
    return;
  }

  const packFormat = await vscode.window.showInputBox({
    prompt: promptMsg.packFormat,
    value: defaultPackAttributes.packFormat,
    validateInput(input: string) {
      return isPositiveInteger(input) ? null : errorMsg.nanInput;
    }
  });
  if (packFormat === undefined) {
    return;
  }

  const description = await vscode.window.showInputBox({
    prompt: promptMsg.description
  });
  if (description === undefined) {
    return;
  }

  const packPath = path.join(rootFolder.uri.fsPath, packName);
  writePackScaffold(packPath, namespace, packFormat, description);
}

export function writePackScaffold(packPath: string, namespace: string, packFormat: string, description: string) {
  const packMcmeta = getPackMcmeta(packFormat, description);

  fs.mkdirSync(packPath);
  fs.writeFileSync(path.join(packPath, "pack.mcmeta"), packMcmeta, { flag: "wx" });
  fs.writeFileSync(path.join(packPath, "pack.png"), Buffer.from(defaultPackPng, "base64"), { flag: "wx" });
  createNamespaceFolders(packPath, namespace);
}

export function createNamespaceFolders(packPath: string, namespace: string) {
  const namespacePath = path.join(packPath, "assets", namespace);
  for (const resourcePath of [
    "blockstates",
    "models",
    path.join("models", "block"),
    path.join("models", "item"),
    "textures",
    path.join("textures", "block"),
    path.join("textures", "item")
  ]) {
    fs.mkdirSync(path.join(namespacePath, resourcePath), { recursive: true });
  }
}

function isEmpty(input: string): boolean {
  return input.trim().length === 0;
}

function isPositiveInteger(input: string): boolean {
  return /^[1-9]\d*$/.test(input.trim());
}
