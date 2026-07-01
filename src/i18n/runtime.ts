import * as vscode from "vscode";
import type { LocalizedMessage } from "./messages";

export function localize(value: string | LocalizedMessage): string {
  if (typeof value === "string") {
    return vscode.l10n.t(value);
  }

  if (value.comment !== undefined) {
    return vscode.l10n.t({
      message: value.message,
      args: value.args ?? [],
      comment: value.comment
    });
  }

  return vscode.l10n.t(value.message, ...(value.args ?? []));
}
