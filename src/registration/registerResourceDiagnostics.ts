import * as vscode from "vscode";
import {
  clearResourceDiagnostics,
  disposeResourceDiagnosticsRefreshes,
  refreshResourceDiagnostics,
  type ResourceDiagnosticResolver
} from "../diagnostics/resourceDiagnostics";
import { createKeyedDebouncer, createTrailingDebouncer } from "../utils/debounce";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigationFacade";

export interface ResourceDiagnosticsController extends vscode.Disposable {
  refresh(document: vscode.TextDocument): void;
  refreshSoon(document: vscode.TextDocument, delay?: number): void;
  clear(document: vscode.TextDocument): void;
  refreshAll(): void;
  refreshAllSoon(delay?: number): void;
}

export function registerResourceDiagnostics(
  context: Pick<vscode.ExtensionContext, "subscriptions">,
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
  private readonly documentRefreshDebouncer = createKeyedDebouncer();
  private readonly refreshAllDebouncer = createTrailingDebouncer();

  constructor(
    private readonly collection: vscode.DiagnosticCollection,
    private readonly resolveReference: ResourceDiagnosticResolver
  ) {}

  refresh(document: vscode.TextDocument): void {
    this.cancelDocumentRefresh(document.uri.toString());
    void refreshResourceDiagnostics(document, this.collection, this.resolveReference);
  }

  refreshSoon(document: vscode.TextDocument, delay = 150): void {
    this.documentRefreshDebouncer.schedule(document.uri.toString(), () => {
      void refreshResourceDiagnostics(document, this.collection, this.resolveReference);
    }, delay);
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
    this.refreshAllDebouncer.schedule(() => this.refreshAll(), delay);
  }

  dispose(): void {
    this.refreshAllDebouncer.cancel();
    this.documentRefreshDebouncer.cancelAll();
    disposeResourceDiagnosticsRefreshes(this.collection);
    this.collection.dispose();
  }

  private cancelDocumentRefresh(key: string): void {
    this.documentRefreshDebouncer.cancel(key);
  }
}
