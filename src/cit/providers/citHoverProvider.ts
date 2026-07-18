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
  markdown.appendMarkdown(vscode.l10n.t("Value type: {0}", localizeValueType(info.valueType)));
  if (info.defaultValue !== undefined) {
    markdown.appendMarkdown(`\n\n${vscode.l10n.t("Default: {0}", `\`${info.defaultValue}\``)}`);
  }
  if (info.appliesTo.length > 0) {
    markdown.appendMarkdown(`\n\n${vscode.l10n.t("Applies to: {0}", info.appliesTo.map(localizeCitType).join(", "))}`);
  }
  if (info.aliases.length > 0) {
    markdown.appendMarkdown(`\n\n${vscode.l10n.t("Aliases: {0}", info.aliases.map(value => `\`${value}\``).join(", "))}`);
  }
  if (info.citResewnOnly) {
    markdown.appendMarkdown(`\n\n${vscode.l10n.t("CIT Resewn only.")}`);
  }
  if (info.runtimeStatus) {
    markdown.appendMarkdown(`\n\n${vscode.l10n.t("Runtime status: {0}", localizeRuntimeStatus(info.runtimeStatus))}`);
  }
  if (info.runtimeNote) {
    markdown.appendMarkdown(`\n\n${info.runtimeNote}`);
  }
  return markdown;
}

function localizeValueType(valueType: CitHoverInfo["valueType"]): string {
  switch (valueType) {
    case "asset": return vscode.l10n.t("Asset reference");
    case "blendFunc": return vscode.l10n.t("Blend function");
    case "boolean": return vscode.l10n.t("Boolean");
    case "enum": return vscode.l10n.t("Enumeration");
    case "integer": return vscode.l10n.t("Integer");
    case "nbtMatch": return vscode.l10n.t("NBT match");
    case "nonNegativeNumber": return vscode.l10n.t("Non-negative number");
    case "number": return vscode.l10n.t("Number");
    case "positiveInteger": return vscode.l10n.t("Positive integer");
    case "positiveNumber": return vscode.l10n.t("Positive number");
    case "range": return vscode.l10n.t("Range");
    case "rangeList": return vscode.l10n.t("Range list");
    case "resourceList": return vscode.l10n.t("Resource list");
    case "string": return vscode.l10n.t("String");
  }
}

function localizeCitType(citType: CitHoverInfo["appliesTo"][number]): string {
  switch (citType) {
    case "base": return vscode.l10n.t("All CIT types");
    case "item": return vscode.l10n.t("Item");
    case "armor": return vscode.l10n.t("Armor");
    case "elytra": return vscode.l10n.t("Elytra");
    case "enchantment": return vscode.l10n.t("Enchantment");
  }
}

function localizeRuntimeStatus(runtimeStatus: NonNullable<CitHoverInfo["runtimeStatus"]>): string {
  switch (runtimeStatus) {
    case "supported": return vscode.l10n.t("Supported");
    case "legacy": return vscode.l10n.t("Legacy");
  }
}

function toVsCodeRange(range: CitHoverInfo["range"]): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  );
}
