import * as vscode from "vscode";
import type {
  ResourceSearchKind,
  ResourceSearchMatch
} from "../services/resourceSearchModel";
import type { ResourceSearchResponse } from "../services/resourceSearchService";

export interface ResourceSearchQuickPickItem extends vscode.QuickPickItem {
  readonly match?: ResourceSearchMatch;
}

export function presentResourceSearchResponse(
  response: ResourceSearchResponse
): ResourceSearchQuickPickItem[] {
  const items = response.matches.map(presentMatch);
  const coverage = response.coverage === "partial"
    ? vscode.l10n.t("Some resource results may be incomplete.")
    : response.coverage === "unavailable"
      ? vscode.l10n.t("The resource inventory is unavailable.")
      : "";
  if (coverage) {
    items.unshift(resourceSearchStatusItem(coverage));
  }
  if (response.matches.length === 0) {
    items.push(resourceSearchStatusItem(vscode.l10n.t("No matching resources.")));
  }
  return items;
}

export function resourceSearchStatusItem(label: string): ResourceSearchQuickPickItem {
  return {
    label,
    kind: vscode.QuickPickItemKind.Separator,
    alwaysShow: true
  };
}

export function localizedResourceSearchKind(kind: ResourceSearchKind): string {
  switch (kind) {
    case "blockstate": return vscode.l10n.t("Blockstate");
    case "model": return vscode.l10n.t("Model");
    case "texture": return vscode.l10n.t("Texture");
  }
}

function presentMatch(match: ResourceSearchMatch): ResourceSearchQuickPickItem {
  const status = localizedMaterializationState(match);
  const ownership = match.producer.origin === "generated"
    ? vscode.l10n.t("RSGL")
    : vscode.l10n.t("Handwritten");
  const resolution = match.resolutionStatus === "conflict"
    ? ` · ${vscode.l10n.t("Conflict")}`
    : "";
  return {
    label: match.id,
    description: `${localizedResourceSearchKind(match.kind)} · ${ownership}${status ? ` · ${status}` : ""}${resolution}`,
    detail: [match.outputPath, match.sourceUri]
      .filter((value): value is string => Boolean(value))
      .join(" · "),
    alwaysShow: true,
    match
  };
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
