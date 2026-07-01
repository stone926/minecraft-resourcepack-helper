import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { localize } from "../i18n/runtime";
import { promptMsg, defaultPackAttributes, errorMsg, isPackFormatVersion } from "./constants";
import { createNamespaceFolders, writePackRootFiles } from "./resourcePackScaffold";
import { pickWorkspaceFolder } from "./workspace";

export default async function createNewResourcePackRoot() {
  const rootFolder = await pickWorkspaceFolder();
  if (!rootFolder) {
    return;
  }

  const packPath = rootFolder.uri.fsPath;
  if (fs.existsSync(path.join(packPath, "pack.mcmeta")) || fs.existsSync(path.join(packPath, "pack.png"))) {
    vscode.window.showErrorMessage(vscode.l10n.t("McResHelper: pack.mcmeta or pack.png already exists in the current folder"));
    return;
  }

  const namespace = await vscode.window.showInputBox({
    prompt: localize(promptMsg.namespace),
    value: defaultPackAttributes.namespace,
    validateInput(input: string) {
      return input.trim().length === 0 ? localize(errorMsg.emptyInput) : null;
    }
  });
  if (namespace === undefined) {
    return;
  }

  const packFormat = await vscode.window.showInputBox({
    prompt: localize(promptMsg.packFormat),
    value: defaultPackAttributes.packFormat,
    validateInput(input: string) {
      return isPackFormatVersion(input) ? null : localize(errorMsg.invalidPackFormat);
    }
  });
  if (packFormat === undefined) {
    return;
  }

  const description = await vscode.window.showInputBox({
    prompt: localize(promptMsg.description)
  });
  if (description === undefined) {
    return;
  }

  writePackRootFiles(packPath, packFormat, description);
  createNamespaceFolders(packPath, namespace);
}
