import * as vscode from "vscode";
import {
  clearResourceDiagnostics,
  disposeResourceDiagnosticsRefreshes,
  refreshResourceDiagnostics
} from "../diagnostics/resourceDiagnostics";

export interface ResourceDiagnosticsController extends vscode.Disposable {
  refresh(document: vscode.TextDocument): void;
  clear(document: vscode.TextDocument): void;
  refreshAll(): void;
  refreshAllSoon(delay?: number): void;
}

export function registerResourceDiagnostics(
  context: vscode.ExtensionContext
): ResourceDiagnosticsController {
  const collection = vscode.languages.createDiagnosticCollection(vscode.l10n.t("McResHelper resources"));
  const controller = new RegisteredResourceDiagnostics(collection);
  context.subscriptions.push(controller);
  controller.refreshAllSoon();
  return controller;
}

class RegisteredResourceDiagnostics implements ResourceDiagnosticsController {
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  refresh(document: vscode.TextDocument): void {
    void refreshResourceDiagnostics(document, this.collection);
  }

  clear(document: vscode.TextDocument): void {
    clearResourceDiagnostics(document, this.collection);
  }

  refreshAll(): void {
    for (const document of vscode.workspace.textDocuments) {
      this.refresh(document);
    }
  }

  refreshAllSoon(delay = 250): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshAll();
    }, delay);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    disposeResourceDiagnosticsRefreshes(this.collection);
    this.collection.dispose();
  }
}
