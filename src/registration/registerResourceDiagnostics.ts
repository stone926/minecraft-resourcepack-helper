import * as vscode from "vscode";
import {
  clearResourceDiagnostics,
  disposeResourceDiagnosticsRefreshes,
  refreshResourceDiagnostics,
  type ResourceDiagnosticResolver
} from "../diagnostics/resourceDiagnostics";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigationFacade";

export interface ResourceDiagnosticsController extends vscode.Disposable {
  refresh(document: vscode.TextDocument): void;
  refreshSoon(document: vscode.TextDocument, delay?: number): void;
  clear(document: vscode.TextDocument): void;
  refreshAll(): void;
  refreshAllSoon(delay?: number): void;
}

export function registerResourceDiagnostics(
  context: vscode.ExtensionContext,
  navigation: ResourceUniverseNavigation
): ResourceDiagnosticsController {
  const collection = vscode.languages.createDiagnosticCollection(vscode.l10n.t("McResHelper resources"));
  const controller = new RegisteredResourceDiagnostics(
    collection,
    (document, reference) => navigation.resolveReference(document, reference, {
      includeGenerated: true
    })
  );
  context.subscriptions.push(controller);
  controller.refreshAllSoon();
  return controller;
}

class RegisteredResourceDiagnostics implements ResourceDiagnosticsController {
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly documentRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly collection: vscode.DiagnosticCollection,
    private readonly resolveReference: ResourceDiagnosticResolver
  ) {}

  refresh(document: vscode.TextDocument): void {
    this.cancelDocumentRefresh(document.uri.toString());
    void refreshResourceDiagnostics(document, this.collection, this.resolveReference);
  }

  refreshSoon(document: vscode.TextDocument, delay = 150): void {
    const key = document.uri.toString();
    this.cancelDocumentRefresh(key);
    this.documentRefreshTimers.set(key, setTimeout(() => {
      this.documentRefreshTimers.delete(key);
      void refreshResourceDiagnostics(document, this.collection, this.resolveReference);
    }, delay));
  }

  clear(document: vscode.TextDocument): void {
    this.cancelDocumentRefresh(document.uri.toString());
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
    for (const timer of this.documentRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.documentRefreshTimers.clear();
    disposeResourceDiagnosticsRefreshes(this.collection);
    this.collection.dispose();
  }

  private cancelDocumentRefresh(key: string): void {
    const timer = this.documentRefreshTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.documentRefreshTimers.delete(key);
    }
  }
}
