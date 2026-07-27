import * as vscode from "vscode";
import { isAbortError } from "./abortError";

/** Logs and surfaces a background failure; abort cancellations stay silent. */
export function reportBackgroundError(message: string, error: unknown): void {
  if (isAbortError(error)) {
    return;
  }
  console.error(message, error);
  void vscode.window.showErrorMessage(vscode.l10n.t("{0}: {1}",
    message,
    error instanceof Error ? error.message : String(error)
  ));
}
