import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMsg, promptMsg, defaultPackAttributes, isPackFormatVersion } from "./constants";
import { writePackScaffold } from "./resourcePackScaffold";
import { pickWorkspaceFolder } from "./workspace";

export default async function createNewResourcePack() {
  const rootFolder = await pickWorkspaceFolder();
  if (!rootFolder) {
    return;
  }

  const packName = await vscode.window.showInputBox({
    prompt: vscode.l10n.t(promptMsg.packName),
    validateInput(input: string) {
      if (isEmpty(input)) {
        return vscode.l10n.t(errorMsg.emptyInput);
      }

      if (fs.existsSync(path.join(rootFolder.uri.fsPath, input))) {
        return vscode.l10n.t(errorMsg.folderAlreadyExist);
      }

      return null;
    }
  });
  if (packName === undefined) {
    return;
  }

  const namespace = await vscode.window.showInputBox({
    prompt: vscode.l10n.t(promptMsg.namespace),
    value: defaultPackAttributes.namespace,
    validateInput(input: string) {
      return isEmpty(input) ? vscode.l10n.t(errorMsg.emptyInput) : null;
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

  const packPath = path.join(rootFolder.uri.fsPath, packName);
  writePackScaffold(packPath, namespace, packFormat, description);
}

function isEmpty(input: string): boolean {
  return input.trim().length === 0;
}
