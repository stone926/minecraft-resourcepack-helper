import * as vscode from "vscode";
import {
  resourceSearchKinds,
  type ResourceSearchKind,
  type ResourceSearchMatch
} from "../services/resourceSearchModel";
import type {
  ResourceSearchRequest,
  ResourceSearchService
} from "../services/resourceSearchService";
import {
  localizedResourceSearchKind,
  presentResourceSearchResponse,
  resourceSearchStatusItem,
  type ResourceSearchQuickPickItem
} from "./resourceGraphSearchQuickPickPresentation";

interface ResourceKindButton extends vscode.QuickInputButton {
  readonly kind: ResourceSearchKind;
}

interface ActivePicker {
  readonly picker: vscode.QuickPick<ResourceSearchQuickPickItem>;
  readonly subscriptions: vscode.Disposable[];
  renderedRequestId?: number;
}

export class ResourceGraphSearchQuickPick implements vscode.Disposable {
  private readonly selectedKinds = new Set<ResourceSearchKind>(resourceSearchKinds);
  private active: ActivePicker | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private activeSearchController: AbortController | undefined;
  private requestSequence = 0;
  private lastQuery = "";
  private readonly invalidationSubscription: vscode.Disposable;
  private disposed = false;

  public constructor(
    private readonly search: Pick<ResourceSearchService, "search" | "onDidInvalidate">,
    private readonly selectResource: (match: ResourceSearchMatch) => void
  ) {
    this.invalidationSubscription = search.onDidInvalidate(() => {
      const picker = this.active?.picker;
      if (picker && picker.value.trim() && this.selectedKinds.size > 0) {
        this.scheduleSearch(picker);
      }
    });
  }

  public show(): void {
    if (this.disposed) {
      return;
    }
    if (this.active) {
      this.active.picker.show();
      return;
    }

    const picker = vscode.window.createQuickPick<ResourceSearchQuickPickItem>();
    picker.title = vscode.l10n.t("Select a resource to inspect its relations");
    picker.placeholder = vscode.l10n.t("Search resource IDs and paths");
    picker.matchOnDescription = false;
    picker.matchOnDetail = false;
    picker.keepScrollPosition = true;
    picker.buttons = this.createKindButtons();
    picker.items = [resourceSearchStatusItem(
      vscode.l10n.t("Type to search local and RSGL-generated resources.")
    )];

    const subscriptions = [
      picker.onDidChangeValue(() => this.scheduleSearch(picker)),
      picker.onDidTriggerButton(button => {
        const kind = (button as ResourceKindButton).kind;
        if (!resourceSearchKinds.includes(kind)) {
          return;
        }
        if (this.selectedKinds.has(kind)) {
          this.selectedKinds.delete(kind);
        } else {
          this.selectedKinds.add(kind);
        }
        picker.buttons = this.createKindButtons();
        this.scheduleSearch(picker, 0);
      }),
      picker.onDidAccept(() => {
        if (this.active?.renderedRequestId !== this.requestSequence) {
          return;
        }
        const match = picker.selectedItems[0]?.match;
        if (!match) {
          return;
        }
        this.lastQuery = picker.value;
        this.selectResource(match);
        picker.hide();
      }),
      picker.onDidHide(() => this.closePicker(picker))
    ];
    this.active = { picker, subscriptions };
    picker.show();
    if (this.lastQuery) {
      picker.value = this.lastQuery;
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.invalidationSubscription.dispose();
    const active = this.active;
    if (active) {
      this.closePicker(active.picker);
    } else {
      this.cancelScheduledSearch();
      this.cancelActiveSearch();
      this.requestSequence++;
    }
  }

  private scheduleSearch(
    picker: vscode.QuickPick<ResourceSearchQuickPickItem>,
    delay = 120
  ): void {
    this.cancelScheduledSearch();
    this.cancelActiveSearch();
    const requestId = ++this.requestSequence;
    const active = this.active;
    if (active?.picker === picker) {
      active.renderedRequestId = undefined;
    }
    const query = picker.value.trim();
    const kinds = resourceSearchKinds.filter(kind => this.selectedKinds.has(kind));
    if (!query) {
      picker.busy = false;
      picker.items = [resourceSearchStatusItem(
        vscode.l10n.t("Type to search local and RSGL-generated resources.")
      )];
      return;
    }
    if (kinds.length === 0) {
      picker.busy = false;
      picker.items = [resourceSearchStatusItem(
        vscode.l10n.t("Select at least one resource type.")
      )];
      return;
    }
    picker.busy = true;
    picker.items = [resourceSearchStatusItem(vscode.l10n.t("Searching resources…"))];
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      const controller = new AbortController();
      this.activeSearchController = controller;
      void this.runSearch(picker, requestId, query, kinds, controller);
    }, delay);
  }

  private async runSearch(
    picker: vscode.QuickPick<ResourceSearchQuickPickItem>,
    requestId: number,
    query: string,
    kinds: readonly ResourceSearchKind[],
    controller: AbortController
  ): Promise<void> {
    if (!this.isCurrent(picker, requestId)) {
      return;
    }
    try {
      const response = await this.search.search({
        query,
        kinds,
        limit: 200,
        signal: controller.signal
      } satisfies ResourceSearchRequest);
      if (!this.isCurrent(picker, requestId)) {
        return;
      }
      const items = presentResourceSearchResponse(response);
      picker.items = items;
      picker.activeItems = items.filter(item => item.match).slice(0, 1);
      if (this.active?.picker === picker) {
        this.active.renderedRequestId = requestId;
      }
    } catch (error) {
      if (!this.isCurrent(picker, requestId)) {
        return;
      }
      picker.items = [resourceSearchStatusItem(vscode.l10n.t("Resource search failed: {0}",
        error instanceof Error ? error.message : String(error)
      ))];
    } finally {
      if (this.activeSearchController === controller) {
        this.activeSearchController = undefined;
      }
      if (this.isCurrent(picker, requestId)) {
        picker.busy = false;
      }
    }
  }

  private createKindButtons(): ResourceKindButton[] {
    return resourceSearchKinds.map(kind => {
      const selected = this.selectedKinds.has(kind);
      const label = localizedResourceSearchKind(kind);
      return {
        kind,
        iconPath: new vscode.ThemeIcon(selected ? "check" : "circle-large-outline"),
        tooltip: selected
          ? vscode.l10n.t("Exclude {0}", label)
          : vscode.l10n.t("Include {0}", label)
      };
    });
  }

  private closePicker(
    picker: vscode.QuickPick<ResourceSearchQuickPickItem>
  ): void {
    if (this.active?.picker !== picker) {
      return;
    }
    const { subscriptions } = this.active;
    this.active = undefined;
    this.cancelScheduledSearch();
    this.cancelActiveSearch();
    this.requestSequence++;
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
    picker.dispose();
  }

  private cancelScheduledSearch(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = undefined;
    }
  }

  private cancelActiveSearch(): void {
    this.activeSearchController?.abort();
    this.activeSearchController = undefined;
  }

  private isCurrent(
    picker: vscode.QuickPick<ResourceSearchQuickPickItem>,
    requestId: number
  ): boolean {
    return !this.disposed
      && this.active?.picker === picker
      && this.requestSequence === requestId;
  }
}
