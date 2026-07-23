import * as vscode from "vscode";
import { isSemanticDiagnosticsDocument } from "../diagnostics/semanticDiagnosticsCore";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigationFacade";
import { isResourceGraphDocumentPath } from "../utils/resourceGraphSearch";
import type { ResourceGraphTreeItem } from "../views/resourceGraphTreeItem";
import { DeferredRegistrationOwner } from "./deferredRegistrationOwner";
import { DeferredResourceGraphTreeProvider } from "./deferredResourceGraphTreeProvider";
import { ResourceSearchViewProvider } from "../views/resourceSearchView";
import { registerLanguageProviders } from "./registerLanguageProviders";
import { registerResourceDiagnostics, type ResourceDiagnosticsController } from "./registerResourceDiagnostics";
import { registerResourceGraph, type ResourceGraphRegistration } from "./registerResourceGraph";
import { registerResourceSurfaceCommands } from "./registerResourceSurfaceCommands";
import { RegistrationScope } from "./registrationScope";
import { registerWorkspaceEvents, type WorkspaceEventController } from "./registerWorkspaceEvents";

export interface DeferredResourceSurfaceRegistration extends vscode.Disposable {
  readonly isInstalled: boolean;
}

interface InstalledResourceSurfaces {
  readonly scope: RegistrationScope;
  readonly resourceGraph: ResourceGraphRegistration;
  readonly diagnostics: ResourceDiagnosticsController;
  readonly workspaceEvents: WorkspaceEventController;
}

/**
 * Registers stable command/view/document entry points synchronously, while the
 * resource providers and listeners move to the next turn on a cold workspace.
 */
export function registerDeferredResourceSurfaces(
  context: vscode.ExtensionContext,
  navigation: ResourceUniverseNavigation
): DeferredResourceSurfaceRegistration {
  const entryPointScope = new RegistrationScope();
  let bootstrap: vscode.Disposable | undefined;
  const owner = new DeferredRegistrationOwner<
    ReturnType<typeof setImmediate>,
    InstalledResourceSurfaces
  >(
    () => installResourceSurfaces(navigation),
    {
      schedule: callback => setImmediate(callback),
      cancel: handle => clearImmediate(handle)
    },
    error => reportDeferredRegistrationError(error),
    installation => installation.scope.dispose(),
    () => {
      bootstrap?.dispose();
      bootstrap = undefined;
    }
  );

  try {
    bootstrap = vscode.workspace.onDidOpenTextDocument(document => {
      if (!isDeferredResourceDocument(document)) {
        return;
      }
      const installation = owner.ensureInstalled();
      installation.workspaceEvents.reconcileOpenedDocument(document);
    });
    entryPointScope.subscriptions.push(bootstrap);

    const treeProvider = new DeferredResourceGraphTreeProvider<ResourceGraphTreeItem>(
      () => owner.ensureInstalled().resourceGraph.provider
    );
    entryPointScope.subscriptions.push(treeProvider);
    entryPointScope.subscriptions.push(vscode.window.createTreeView(
      "McResHelper.resourceGraph",
      { treeDataProvider: treeProvider, showCollapseAll: true }
    ));
    const searchViewProvider = new ResourceSearchViewProvider(
      () => owner.ensureInstalled().resourceGraph.controller
    );
    entryPointScope.subscriptions.push(searchViewProvider);
    entryPointScope.subscriptions.push(vscode.window.registerWebviewViewProvider(
      "McResHelper.resourceSearch",
      searchViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ));

    registerResourceSurfaceCommands(entryPointScope, () => {
      const installation = owner.ensureInstalled();
      return {
        resourceGraph: installation.resourceGraph.controller,
        workspaceEvents: installation.workspaceEvents
      };
    });
    entryPointScope.subscriptions.push(owner);

    const openResourceDocuments = vscode.workspace.textDocuments.filter(
      isDeferredResourceDocument
    );
    owner.start(openResourceDocuments.length > 0);
    if (openResourceDocuments.length > 0) {
      const installation = owner.ensureInstalled();
      for (const document of openResourceDocuments) {
        installation.workspaceEvents.reconcileOpenedDocument(document);
      }
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (!entryPointScope.subscriptions.includes(owner)) {
      try {
        owner.dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      entryPointScope.dispose();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Resource entry-point registration and rollback both failed",
        { cause: error }
      );
    }
    throw error;
  }

  const registration: DeferredResourceSurfaceRegistration = {
    get isInstalled() {
      return owner.isInstalled;
    },
    dispose: () => entryPointScope.dispose()
  };
  context.subscriptions.push(registration);
  return registration;
}

function installResourceSurfaces(
  navigation: ResourceUniverseNavigation
): InstalledResourceSurfaces {
  const scope = new RegistrationScope();
  try {
    const resourceGraph = registerResourceGraph(scope, navigation);
    const diagnostics = registerResourceDiagnostics(scope, navigation);
    registerLanguageProviders(scope, navigation);
    const workspaceEvents = registerWorkspaceEvents(scope, {
      diagnostics,
      resourceGraph: resourceGraph.controller
    });
    return { scope, resourceGraph, diagnostics, workspaceEvents };
  } catch (error) {
    try {
      scope.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Resource surface installation and rollback both failed",
        { cause: cleanupError }
      );
    }
    throw error;
  }
}

function isDeferredResourceDocument(document: vscode.TextDocument): boolean {
  return isResourceGraphDocumentPath(document.fileName)
    || isSemanticDiagnosticsDocument(document);
}

function reportDeferredRegistrationError(error: unknown): void {
  console.error("Resource tooling could not be initialized.", error);
  void vscode.window.showErrorMessage(vscode.l10n.t("Resource tooling could not be initialized: {0}",
    error instanceof Error ? error.message : String(error)
  ));
}
