import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { collectResourcePackAttributes } from "./resourcePackInputs";
import { createNamespaceFolders, writePackRootFiles } from "./resourcePackScaffold";
import { pickWorkspaceFolder } from "./workspace";

export async function createNewResourcePackRoot() {
  const rootFolder = await pickWorkspaceFolder();
  if (!rootFolder) {
    return;
  }

  const packPath = rootFolder.uri.fsPath;
  if (fs.existsSync(path.join(packPath, "pack.mcmeta")) || fs.existsSync(path.join(packPath, "pack.png"))) {
    vscode.window.showErrorMessage(vscode.l10n.t("McResHelper: pack.mcmeta or pack.png already exists in the current folder"));
    return;
  }

  const attributes = await collectResourcePackAttributes();
  if (!attributes) {
    return;
  }

  writePackRootFiles(packPath, attributes.packFormat, attributes.description);
  createNamespaceFolders(packPath, attributes.namespace);
}

export default createNewResourcePackRoot;
