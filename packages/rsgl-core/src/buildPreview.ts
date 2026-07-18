import type { RsglWritePlan, RsglWriteStatus } from "./compiler";

export interface RsglBuildPreviewMessages {
  title: string;
  entry: string;
  sourceRoot: string;
  outputRoot: string;
  summary: string;
  plannedChanges: string;
  noFileChanges: string;
  diffPreview: string;
  binaryCopyFrom: string;
  omittedDiffLines: string;
  statusCreate: string;
  statusUpdate: string;
  statusUnchanged: string;
}

export interface RsglBuildPreviewFormatOptions {
  entryFileName?: string;
  sourceRoot?: string;
  maxDiffLinesPerFile?: number;
  messages?: RsglBuildPreviewMessages;
}

export const defaultRsglBuildPreviewMessages: Readonly<RsglBuildPreviewMessages> = {
  title: "RSGL Build Preview",
  entry: "Entry: {0}",
  sourceRoot: "Source root: {0}",
  outputRoot: "Output root: {0}",
  summary: "Summary: {0} create, {1} update, {2} unchanged",
  plannedChanges: "Planned Changes",
  noFileChanges: "No file changes.",
  diffPreview: "Diff Preview",
  binaryCopyFrom: "Binary copy from {0}",
  omittedDiffLines: "... {0} more diff line(s) omitted",
  statusCreate: "create",
  statusUpdate: "update",
  statusUnchanged: "unchanged"
};

export function formatRsglBuildPreview(
  plan: RsglWritePlan,
  options: RsglBuildPreviewFormatOptions = {}
): string {
  const maxDiffLinesPerFile = options.maxDiffLinesPerFile ?? 80;
  const messages = options.messages ?? defaultRsglBuildPreviewMessages;
  const lines = [
    `# ${messages.title}`,
    "",
    ...(options.entryFileName ? [formatPreviewMessage(messages.entry, options.entryFileName)] : []),
    ...(options.sourceRoot ? [formatPreviewMessage(messages.sourceRoot, options.sourceRoot)] : []),
    formatPreviewMessage(messages.outputRoot, plan.outputRoot),
    formatPreviewMessage(
      messages.summary,
      plan.summary.create,
      plan.summary.update,
      plan.summary.unchanged
    ),
    "",
    `## ${messages.plannedChanges}`,
    ""
  ];
  const changedEntries = plan.entries.filter(entry => entry.status !== "unchanged");
  if (changedEntries.length === 0) {
    lines.push(messages.noFileChanges);
  } else {
    for (const entry of changedEntries) {
      const diff = entry.diff ? ` (+${entry.diff.addedLines} -${entry.diff.removedLines})` : "";
      lines.push(`- ${statusMessage(entry.status, messages)}: ${entry.outputPath}${diff}`);
    }
    lines.push("", `## ${messages.diffPreview}`, "");
    for (const entry of changedEntries) {
      lines.push(`### ${entry.outputPath}`, "", "```diff");
      if (isCopyPlanEntry(entry)) {
        lines.push(formatPreviewMessage(messages.binaryCopyFrom, entry.copyFrom));
      } else {
        lines.push(...createPreviewDiffLines(
          entry.previousContent,
          entry.content,
          maxDiffLinesPerFile,
          messages
        ));
      }
      lines.push("```", "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function isCopyPlanEntry(entry: RsglWritePlan["entries"][number]): entry is RsglWritePlan["entries"][number] & { copyFrom: string } {
  return "copyFrom" in entry;
}

function createPreviewDiffLines(
  previousContent: string | undefined,
  nextContent: string,
  maxLines: number,
  messages: RsglBuildPreviewMessages
): string[] {
  if (previousContent === undefined) {
    return truncateDiffLines(splitPreviewLines(nextContent).map(line => `+${line}`), maxLines, messages);
  }

  const previousLines = splitPreviewLines(previousContent);
  const nextLines = splitPreviewLines(nextContent);
  const commonPrefixLength = countPreviewCommonPrefix(previousLines, nextLines);
  const commonSuffixLength = countPreviewCommonSuffix(previousLines, nextLines, commonPrefixLength);
  const before = previousLines.slice(Math.max(0, commonPrefixLength - 3), commonPrefixLength)
    .map(line => ` ${line}`);
  const removed = previousLines.slice(commonPrefixLength, previousLines.length - commonSuffixLength)
    .map(line => `-${line}`);
  const added = nextLines.slice(commonPrefixLength, nextLines.length - commonSuffixLength)
    .map(line => `+${line}`);
  const after = nextLines.slice(nextLines.length - commonSuffixLength, Math.min(nextLines.length, nextLines.length - commonSuffixLength + 3))
    .map(line => ` ${line}`);
  return truncateDiffLines([...before, ...removed, ...added, ...after], maxLines, messages);
}

function truncateDiffLines(
  lines: string[],
  maxLines: number,
  messages: RsglBuildPreviewMessages
): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  const kept = Math.max(0, maxLines - 1);
  return [
    ...lines.slice(0, kept),
    formatPreviewMessage(messages.omittedDiffLines, lines.length - kept)
  ];
}

function splitPreviewLines(value: string): string[] {
  return value.length === 0 ? [] : value.split(/\r?\n/);
}

function countPreviewCommonPrefix(left: string[], right: string[]): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index++;
  }
  return index;
}

function countPreviewCommonSuffix(left: string[], right: string[], prefixLength: number): number {
  let count = 0;
  while (
    count + prefixLength < left.length &&
    count + prefixLength < right.length &&
    left[left.length - count - 1] === right[right.length - count - 1]
  ) {
    count++;
  }
  return count;
}

function statusMessage(status: RsglWriteStatus, messages: RsglBuildPreviewMessages): string {
  switch (status) {
    case "create":
      return messages.statusCreate;
    case "update":
      return messages.statusUpdate;
    case "unchanged":
      return messages.statusUnchanged;
  }
}

function formatPreviewMessage(template: string, ...values: Array<string | number>): string {
  return template.replace(/\{(\d+)\}/g, (placeholder, rawIndex: string) => {
    const index = Number(rawIndex);
    return index < values.length ? String(values[index]) : placeholder;
  });
}
