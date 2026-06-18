import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultPackPng, promptMsg, defaultPackAttributes, getPackMcmeta, errorMsg, isPackFormatVersion } from "./constants";
import { createNamespaceFolders } from "./createNewResourcePack";

export default async function createNewResourcePackRoot() {
  if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders[0]) {
    vscode.window.showErrorMessage(vscode.l10n.t("McResHelper: No open folder, failed to create resource pack"));
    return;
  }

  const rootFolder = vscode.workspace.workspaceFolders[0];
  const packPath = rootFolder.uri.fsPath;
  if (fs.existsSync(path.join(packPath, "pack.mcmeta")) || fs.existsSync(path.join(packPath, "pack.png"))) {
    vscode.window.showErrorMessage(vscode.l10n.t("McResHelper: pack.mcmeta or pack.png already exists in the current folder"));
    return;
  }

  const namespace = await vscode.window.showInputBox({
    prompt: vscode.l10n.t(promptMsg.namespace),
    value: defaultPackAttributes.namespace,
    validateInput(input: string) {
      return input.trim().length === 0 ? vscode.l10n.t(errorMsg.emptyInput) : null;
    }
  });
  if (namespace === undefined) {
    return;
  }

  const packFormat = await vscode.window.showInputBox({
    prompt: vscode.l10n.t(promptMsg.packFormat),
    value: defaultPackAttributes.packFormat,
    validateInput(input: string) {
      return isPackFormatVersion(input) ? null : vscode.l10n.t(errorMsg.invalidPackFormat);
    }
  });
  if (packFormat === undefined) {
    return;
  }

  const description = await vscode.window.showInputBox({
    prompt: vscode.l10n.t(promptMsg.description)
  });
  if (description === undefined) {
    return;
  }

  const packMcmeta = getPackMcmeta(packFormat, description);
  fs.writeFileSync(path.join(packPath, "pack.mcmeta"), packMcmeta, { flag: "wx" });
  fs.writeFileSync(path.join(packPath, "pack.png"), Buffer.from(defaultPackPng, "base64"), { flag: "wx" });
  createNamespaceFolders(packPath, namespace);
}
