import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { localize } from "../i18n/runtime";
import { errorMsg, promptMsg, defaultPackAttributes, isPackFormatVersion } from "./constants";
import { writePackScaffold } from "./resourcePackScaffold";
import { pickWorkspaceFolder } from "./workspace";

export default async function createNewResourcePack() {
  const rootFolder = await pickWorkspaceFolder();
  if (!rootFolder) {
    return;
  }

  const packName = await vscode.window.showInputBox({
    prompt: localize(promptMsg.packName),
    validateInput(input: string) {
      if (isEmpty(input)) {
        return localize(errorMsg.emptyInput);
      }

      if (fs.existsSync(path.join(rootFolder.uri.fsPath, input))) {
        return localize(errorMsg.folderAlreadyExist);
      }

      return null;
    }
  });
  if (packName === undefined) {
    return;
  }

  const namespace = await vscode.window.showInputBox({
    prompt: localize(promptMsg.namespace),
    value: defaultPackAttributes.namespace,
    validateInput(input: string) {
      return isEmpty(input) ? localize(errorMsg.emptyInput) : null;
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

  const packPath = path.join(rootFolder.uri.fsPath, packName);
  writePackScaffold(packPath, namespace, packFormat, description);
}

function isEmpty(input: string): boolean {
  return input.trim().length === 0;
}
