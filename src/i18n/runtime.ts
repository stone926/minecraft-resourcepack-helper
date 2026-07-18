import * as vscode from "vscode";
import type { LocalizedMessage } from "./messages";

export function localize(value: LocalizedMessage): string {
  if (value.comment !== undefined) {
    return vscode.l10n.t({
      message: value.message,
      args: value.args ?? [],
      comment: value.comment
    });
  }

  return vscode.l10n.t(value.message, ...(value.args ?? []));
}
