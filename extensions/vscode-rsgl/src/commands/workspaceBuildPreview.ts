import type { RsglBuildPreviewResult, RsglBuildResult } from "../../../../packages/rsgl-core/src/build";
import type { RsglDirectoryBuildContext, RsglSkippedSourceRoot } from "./buildContexts";

export interface RsglWorkspaceBuildEntry<T extends RsglBuildResult> {
  context: RsglDirectoryBuildContext;
  result: T;
}

export interface RsglWorkspaceBuildPreviewMessages {
  title: string;
  summary(
    sourceDirectories: number,
    created: number,
    updated: number,
    unchanged: number,
    skipped: number
  ): string;
  skippedSourceDirectories: string;
  missingOutputRoot: string;
  noPreview: string;
}

export function formatWorkspaceBuildPreview(
  entries: Array<RsglWorkspaceBuildEntry<RsglBuildPreviewResult>>,
  skipped: RsglSkippedSourceRoot[],
  messages: RsglWorkspaceBuildPreviewMessages
): string {
  const summary = summarizeWorkspaceBuild(entries);
  const lines = [
    `# ${messages.title}`,
    "",
    messages.summary(
      entries.length,
      summary.create,
      summary.update,
      summary.unchanged,
      skipped.length
    ),
    ""
  ];

  if (skipped.length > 0) {
    lines.push(`## ${messages.skippedSourceDirectories}`, "");
    for (const skippedRoot of skipped) {
      lines.push(`- ${skippedRoot.sourceRoot}: ${skippedReason(skippedRoot.reason, messages)}`);
    }
    lines.push("");
  }

  for (const entry of entries) {
    lines.push(`## ${entry.context.sourceRoot}`, "");
    lines.push(...nestMarkdownHeadings(entry.result.preview ?? messages.noPreview, messages.noPreview));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function summarizeWorkspaceBuild(
  entries: Array<RsglWorkspaceBuildEntry<RsglBuildResult>>
): { create: number; update: number; unchanged: number } {
  return entries.reduce((summary, entry) => {
    const planSummary = entry.result.plan?.summary ?? { create: 0, update: 0, unchanged: 0 };
    summary.create += planSummary.create;
    summary.update += planSummary.update;
    summary.unchanged += planSummary.unchanged;
    return summary;
  }, { create: 0, update: 0, unchanged: 0 });
}

function skippedReason(
  reason: RsglSkippedSourceRoot["reason"],
  messages: RsglWorkspaceBuildPreviewMessages
): string {
  switch (reason) {
    case "missingOutputRoot":
      return messages.missingOutputRoot;
  }
}

function nestMarkdownHeadings(markdown: string, noPreview: string): string[] {
  const trimmed = markdown.trimEnd();
  if (trimmed.length === 0) {
    return [noPreview];
  }
  return trimmed.split(/\r?\n/).map(line => line.startsWith("#") ? `#${line}` : line);
}
