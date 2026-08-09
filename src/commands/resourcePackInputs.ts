import * as vscode from "vscode";
import { localize } from "../i18n/runtime";
import {
  defaultPackAttributes,
  errorMsg,
  isPackFormatVersion,
  promptMsg
} from "./constants";

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
    validateInput: input => input.trim().length === 0 ? localize(errorMsg.emptyInput) : null
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
  return description === undefined ? null : { namespace, packFormat, description };
}
