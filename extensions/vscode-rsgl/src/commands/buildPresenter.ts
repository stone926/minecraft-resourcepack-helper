import * as vscode from "vscode";
import type { RsglBuildPreviewResult, RsglBuildResult } from "../../../../packages/rsgl-core/src/build";
import type { RsglDirectoryBuildContext, RsglSkippedSourceRoot } from "./buildContexts";

export interface RsglWorkspaceBuildEntry<T extends RsglBuildResult> {
  context: RsglDirectoryBuildContext;
  result: T;
}

export function runRsglBuildProgress<T>(
  title: string,
  task: (token: vscode.CancellationToken) => Promise<T>
): Thenable<T> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title,
    cancellable: true
  }, (_progress, token) => task(token));
}

export async function showBuildResult(result: RsglBuildResult): Promise<void> {
  if (await showBuildErrors(result)) {
    return;
  }

  const summary = result.plan?.summary ?? { create: 0, update: 0, unchanged: 0 };
  await vscode.window.showInformationMessage(vscode.l10n.t("RSGL build complete: {0} created, {1} updated, {2} unchanged.",
    summary.create,
    summary.update,
    summary.unchanged
  ));
}

export async function showBuildPreview(result: RsglBuildPreviewResult): Promise<void> {
  if (await showBuildErrors(result)) {
    return;
  }

  const preview = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: result.preview ?? ""
  });
  await vscode.window.showTextDocument(preview, { preview: true });
}

export async function showWorkspaceBuildResult(
  entries: Array<RsglWorkspaceBuildEntry<RsglBuildResult>>,
  skipped: RsglSkippedSourceRoot[]
): Promise<void> {
  const errorCount = workspaceErrorCount(entries);
  if (errorCount > 0) {
    await vscode.window.showErrorMessage(vscode.l10n.t("RSGL workspace build failed with {0} error(s); skipped {1} source directories.", errorCount, skipped.length));
    return;
  }

  const summary = summarizeWorkspaceBuild(entries);
  await vscode.window.showInformationMessage(vscode.l10n.t("RSGL workspace build complete: {0} source directories, {1} created, {2} updated, {3} unchanged, {4} skipped.",
    entries.length,
    summary.create,
    summary.update,
    summary.unchanged,
    skipped.length
  ));
}

export async function showWorkspaceBuildPreview(
  entries: Array<RsglWorkspaceBuildEntry<RsglBuildPreviewResult>>,
  skipped: RsglSkippedSourceRoot[]
): Promise<void> {
  const errorCount = workspaceErrorCount(entries);
  if (errorCount > 0) {
    await vscode.window.showErrorMessage(vscode.l10n.t("RSGL workspace build failed with {0} error(s); skipped {1} source directories.", errorCount, skipped.length));
    return;
  }

  const preview = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: formatWorkspaceBuildPreview(entries, skipped)
  });
  await vscode.window.showTextDocument(preview, { preview: true });
}

async function showBuildErrors(result: RsglBuildResult): Promise<boolean> {
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === "error");
  if (errors.length === 0) {
    return false;
  }
  await vscode.window.showErrorMessage(vscode.l10n.t("RSGL build failed with {0} error(s).", errors.length));
  return true;
}

function formatWorkspaceBuildPreview(
  entries: Array<RsglWorkspaceBuildEntry<RsglBuildPreviewResult>>,
  skipped: RsglSkippedSourceRoot[]
): string {
  const summary = summarizeWorkspaceBuild(entries);
  const lines = [
    "# RSGL Workspace Build Preview",
    "",
    `Summary: ${entries.length} source directories, ${summary.create} create, ${summary.update} update, ${summary.unchanged} unchanged, ${skipped.length} skipped`,
    ""
  ];

  if (skipped.length > 0) {
    lines.push("## Skipped Source Directories", "");
    for (const skippedRoot of skipped) {
      lines.push(`- ${skippedRoot.sourceRoot}: ${skippedRoot.reason}`);
    }
    lines.push("");
  }

  for (const entry of entries) {
    lines.push(`## ${entry.context.sourceRoot}`, "");
    lines.push(...nestMarkdownHeadings(entry.result.preview ?? "No preview."));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function summarizeWorkspaceBuild(entries: Array<RsglWorkspaceBuildEntry<RsglBuildResult>>): { create: number; update: number; unchanged: number } {
  return entries.reduce((summary, entry) => {
    const planSummary = entry.result.plan?.summary ?? { create: 0, update: 0, unchanged: 0 };
    summary.create += planSummary.create;
    summary.update += planSummary.update;
    summary.unchanged += planSummary.unchanged;
    return summary;
  }, { create: 0, update: 0, unchanged: 0 });
}

function workspaceErrorCount(entries: Array<RsglWorkspaceBuildEntry<RsglBuildResult>>): number {
  return entries.reduce((count, entry) =>
    count + entry.result.diagnostics.filter(diagnostic => diagnostic.severity === "error").length, 0);
}

function nestMarkdownHeadings(markdown: string): string[] {
  const trimmed = markdown.trimEnd();
  if (trimmed.length === 0) {
    return ["No preview."];
  }
  return trimmed.split(/\r?\n/).map(line => line.startsWith("#") ? `#${line}` : line);
}
