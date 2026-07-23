import * as vscode from "vscode";
import { uniqueValues } from "../../packages/mc-assets/src";
import type { ResourceGraphController } from "../registration/registerResourceGraph";
import {
  isResourceSearchKind,
  type ResourceSearchKind,
  type ResourceSearchMatch
} from "../services/resourceSearchModel";
import type { ResourceGraphNodeNavigation } from "./resourceGraphTreeTypes";
import { resourceSearchWebviewHtml } from "./resourceSearchWebviewHtml";

interface SearchRequestMessage {
  type: "search";
  requestId: number;
  query: string;
  kinds: ResourceSearchKind[];
}

interface NavigateMessage {
  type: "navigate";
  resultId: string;
}

type ResourceSearchViewMessage = SearchRequestMessage | NavigateMessage;

export class ResourceSearchViewProvider
implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private controller: ResourceGraphController | undefined;
  private invalidationSubscription: vscode.Disposable | undefined;
  private viewSubscriptions: vscode.Disposable[] = [];
  private resultNavigation = new Map<string, ResourceGraphNodeNavigation>();
  private latestRequestId = -1;
  private viewSession = 0;
  private dirtyWhileHidden = false;
  private disposed = false;

  public constructor(private readonly resolveController: () => ResourceGraphController) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeViewSubscriptions();
    const session = ++this.viewSession;
    this.view = view;
    this.latestRequestId = -1;
    this.dirtyWhileHidden = false;
    this.resultNavigation.clear();
    view.webview.options = { enableScripts: true };
    view.webview.html = resourceSearchWebviewHtml();
    this.viewSubscriptions.push(
      view.webview.onDidReceiveMessage(value => {
        void this.handleMessage(value, view, session);
      }),
      view.onDidChangeVisibility(() => {
        if (this.isActiveView(view, session) && view.visible && this.dirtyWhileHidden) {
          this.dirtyWhileHidden = false;
          void this.post(view, session, { type: "invalidate" });
        }
      }),
      view.onDidDispose(() => {
        if (this.isActiveView(view, session)) {
          this.disposeViewSubscriptions();
          this.viewSession++;
          this.latestRequestId = -1;
          this.dirtyWhileHidden = false;
          this.resultNavigation.clear();
          this.view = undefined;
        }
      })
    );
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.viewSession++;
    this.disposeViewSubscriptions();
    this.invalidationSubscription?.dispose();
    this.invalidationSubscription = undefined;
    this.resultNavigation.clear();
    this.view = undefined;
  }

  private async handleMessage(
    value: unknown,
    view: vscode.WebviewView,
    session: number
  ): Promise<void> {
    const message = parseMessage(value);
    if (!message || !this.isActiveView(view, session)) {
      return;
    }
    if (message.type === "navigate") {
      const navigation = this.resultNavigation.get(message.resultId);
      if (navigation) {
        await this.getController().navigateNode(navigation);
      }
      return;
    }

    if (message.requestId < this.latestRequestId) {
      return;
    }
    this.latestRequestId = message.requestId;
    if (!message.query.trim() || message.kinds.length === 0) {
      this.resultNavigation.clear();
      await this.post(view, session, {
        type: "searchResult",
        requestId: message.requestId,
        coverage: "authoritative",
        items: []
      });
      return;
    }

    try {
      const response = await this.getController().searchResources({
        query: message.query,
        kinds: message.kinds,
        limit: 200
      });
      if (message.requestId !== this.latestRequestId || !this.isActiveView(view, session)) {
        return;
      }
      const resultNavigation = new Map<string, ResourceGraphNodeNavigation>();
      const items = response.matches.map((match, index) => {
        const resultId = `${message.requestId}:${index}`;
        resultNavigation.set(resultId, match.navigation);
        return presentMatch(resultId, match);
      });
      this.resultNavigation = resultNavigation;
      await this.post(view, session, {
        type: "searchResult",
        requestId: message.requestId,
        coverage: response.coverage,
        items
      });
    } catch (error) {
      if (message.requestId !== this.latestRequestId || !this.isActiveView(view, session)) {
        return;
      }
      this.resultNavigation.clear();
      await this.post(view, session, {
        type: "searchError",
        requestId: message.requestId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private getController(): ResourceGraphController {
    if (!this.controller) {
      this.controller = this.resolveController();
      this.invalidationSubscription = this.controller.onDidInvalidateSearch(() => {
        const view = this.view;
        if (!view) {
          return;
        }
        if (!view.visible) {
          this.dirtyWhileHidden = true;
          return;
        }
        void this.post(view, this.viewSession, { type: "invalidate" });
      });
    }
    return this.controller;
  }

  private isActiveView(view: vscode.WebviewView, session: number): boolean {
    return !this.disposed && this.view === view && this.viewSession === session;
  }

  private async post(
    view: vscode.WebviewView,
    session: number,
    message: unknown
  ): Promise<void> {
    if (this.isActiveView(view, session)) {
      await view.webview.postMessage(message);
    }
  }

  private disposeViewSubscriptions(): void {
    const subscriptions = this.viewSubscriptions;
    this.viewSubscriptions = [];
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  }
}

function presentMatch(resultId: string, match: ResourceSearchMatch): {
  resultId: string;
  label: string;
  kind: ResourceSearchKind;
  kindLabel: string;
  description: string;
  detail: string;
} {
  const status = localizedMaterializationState(match);
  const ownership = match.producer.origin === "generated"
    ? vscode.l10n.t("RSGL")
    : vscode.l10n.t("Handwritten");
  const resolution = match.resolutionStatus === "conflict"
    ? ` · ${vscode.l10n.t("Conflict")}`
    : "";
  return {
    resultId,
    label: match.id,
    kind: match.kind,
    kindLabel: localizedKind(match.kind),
    description: `${ownership}${status ? ` · ${status}` : ""}${resolution}`,
    detail: [match.outputPath, match.sourceUri]
      .filter((value): value is string => Boolean(value))
      .join(" · ")
  };
}

function localizedKind(kind: ResourceSearchKind): string {
  switch (kind) {
    case "blockstate": return vscode.l10n.t("Blockstate");
    case "model": return vscode.l10n.t("Model");
    case "texture": return vscode.l10n.t("Texture");
  }
}

function localizedMaterializationState(match: ResourceSearchMatch): string {
  if (match.producer.origin !== "generated") {
    return "";
  }
  switch (match.materializationState) {
    case "unbuilt": return vscode.l10n.t("Unbuilt");
    case "current": return vscode.l10n.t("Current");
    case "stale": return vscode.l10n.t("Stale");
    case "conflict": return vscode.l10n.t("Conflict");
    case "handwritten": return vscode.l10n.t("Handwritten");
  }
}

function parseMessage(value: unknown): ResourceSearchViewMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "navigate") {
    return typeof record.resultId === "string" && record.resultId.length <= 64
      ? { type: "navigate", resultId: record.resultId }
      : null;
  }
  if (record.type !== "search"
    || !Number.isSafeInteger(record.requestId)
    || (record.requestId as number) < 0
    || typeof record.query !== "string"
    || record.query.length > 256
    || !Array.isArray(record.kinds)
    || !record.kinds.every(kind => typeof kind === "string" && isResourceSearchKind(kind))) {
    return null;
  }
  return {
    type: "search",
    requestId: record.requestId as number,
    query: record.query,
    kinds: uniqueValues(record.kinds as ResourceSearchKind[])
  };
}
