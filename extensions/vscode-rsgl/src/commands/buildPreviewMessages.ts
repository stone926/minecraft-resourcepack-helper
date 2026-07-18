import * as vscode from "vscode";
import type { RsglBuildPreviewMessages } from "../../../../packages/rsgl-core/src/build";
import type { RsglWorkspaceBuildPreviewMessages } from "./workspaceBuildPreview";

export function localizedRsglBuildPreviewMessages(): RsglBuildPreviewMessages {
  return {
    title: vscode.l10n.t("RSGL Build Preview"),
    entry: vscode.l10n.t("Entry: {0}", "{0}"),
    sourceRoot: vscode.l10n.t("Source root: {0}", "{0}"),
    outputRoot: vscode.l10n.t("Output root: {0}", "{0}"),
    summary: vscode.l10n.t(
      "Summary: {0} create, {1} update, {2} unchanged",
      "{0}",
      "{1}",
      "{2}"
    ),
    plannedChanges: vscode.l10n.t("Planned Changes"),
    noFileChanges: vscode.l10n.t("No file changes."),
    diffPreview: vscode.l10n.t("Diff Preview"),
    binaryCopyFrom: vscode.l10n.t("Binary copy from {0}", "{0}"),
    omittedDiffLines: vscode.l10n.t("... {0} more diff line(s) omitted", "{0}"),
    statusCreate: vscode.l10n.t("create"),
    statusUpdate: vscode.l10n.t("update"),
    statusUnchanged: vscode.l10n.t("unchanged")
  };
}

export function localizedWorkspaceBuildPreviewMessages(): RsglWorkspaceBuildPreviewMessages {
  return {
    title: vscode.l10n.t("RSGL Workspace Build Preview"),
    summary: (sourceDirectories, created, updated, unchanged, skipped) => vscode.l10n.t(
      "Summary: {0} source directories, {1} created, {2} updated, {3} unchanged, {4} skipped.",
      sourceDirectories,
      created,
      updated,
      unchanged,
      skipped
    ),
    skippedSourceDirectories: vscode.l10n.t("Skipped Source Directories"),
    missingOutputRoot: vscode.l10n.t("Resource pack output root not found."),
    noPreview: vscode.l10n.t("No preview available.")
  };
}
