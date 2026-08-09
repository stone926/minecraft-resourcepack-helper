import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { localize } from "../i18n/runtime";
import { errorMsg, promptMsg } from "./constants";
import { collectResourcePackAttributes } from "./resourcePackInputs";
import { writePackScaffold } from "./resourcePackScaffold";
import { pickWorkspaceFolder } from "./workspace";

export async function createNewResourcePack() {
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

  const attributes = await collectResourcePackAttributes();
  if (!attributes) {
    return;
  }

  const packPath = path.join(rootFolder.uri.fsPath, packName);
  writePackScaffold(
    packPath,
    attributes.namespace,
    attributes.packFormat,
    attributes.description
  );
}

export default createNewResourcePack;

function isEmpty(input: string): boolean {
  return input.trim().length === 0;
}
