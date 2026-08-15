import * as vscode from "vscode";
import { localize } from "../i18n/runtime";
import {
  defaultPackAttributes,
  errorMsg,
  isPackFormatVersion,
  promptMsg
} from "./constants";
import { isValidResourcePackNamespace } from "./resourcePackScaffold";

export interface ResourcePackAttributes {
  namespace: string;
  packFormat: string;
  description: string;
}

/** Collects the attributes shared by both resource-pack creation commands. */
export async function collectResourcePackAttributes(): Promise<ResourcePackAttributes | null> {
  const namespace = await vscode.window.showInputBox({
    prompt: localize(promptMsg.namespace),
    value: defaultPackAttributes.namespace,
    validateInput: input => {
      if (input.trim().length === 0) {
        return localize(errorMsg.emptyInput);
      }
      return isValidResourcePackNamespace(input) ? null : localize(errorMsg.invalidNamespace);
    }
  });
  if (namespace === undefined) {
    return null;
  }

  const packFormat = await vscode.window.showInputBox({
    prompt: localize(promptMsg.packFormat),
    value: defaultPackAttributes.packFormat,
    validateInput: input => isPackFormatVersion(input) ? null : localize(errorMsg.invalidPackFormat)
  });
  if (packFormat === undefined) {
    return null;
  }

  const description = await vscode.window.showInputBox({
    prompt: localize(promptMsg.description)
  });
  return description === undefined ? null : { namespace: namespace.trim(), packFormat, description };
}
