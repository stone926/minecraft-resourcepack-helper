import * as vscode from "vscode";
import { getCitHoverInfo, type CitHoverInfo } from "../citLanguage";

const citHoverProvider: vscode.HoverProvider = {
  provideHover(document: vscode.TextDocument, position: vscode.Position) {
    const info = getCitHoverInfo(document, position, vscode.env.language);
    if (!info) {
      return null;
    }

    return new vscode.Hover(toMarkdown(info), toVsCodeRange(info.range));
  }
};

export default citHoverProvider;

function toMarkdown(info: CitHoverInfo): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**${info.title}**\n\n`);
  markdown.appendMarkdown(`${info.description}\n\n`);
  markdown.appendMarkdown(vscode.l10n.t("Value type: {0}", `\`${info.valueType}\``));
  if (info.defaultValue !== undefined) {
    markdown.appendMarkdown(`\n\n${vscode.l10n.t("Default: {0}", `\`${info.defaultValue}\``)}`);
  }
  if (info.appliesTo.length > 0) {
    markdown.appendMarkdown(`\n\n${vscode.l10n.t("Applies to: {0}", info.appliesTo.map(value => `\`${value}\``).join(", "))}`);
  }
  if (info.aliases.length > 0) {
    markdown.appendMarkdown(`\n\n${vscode.l10n.t("Aliases: {0}", info.aliases.map(value => `\`${value}\``).join(", "))}`);
  }
  if (info.citResewnOnly) {
    markdown.appendMarkdown(`\n\n${vscode.l10n.t("CIT Resewn only.")}`);
  }
  if (info.runtimeStatus) {
    markdown.appendMarkdown(`\n\n${vscode.l10n.t("Runtime status: {0}", `\`${info.runtimeStatus}\``)}`);
  }
  if (info.runtimeNote) {
    markdown.appendMarkdown(`\n\n${info.runtimeNote}`);
  }
  return markdown;
}

function toVsCodeRange(range: CitHoverInfo["range"]): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  );
}
