import * as vscode from "vscode";
import { getCitHoverInfo, type CitHoverInfo } from "../utils/citLanguage";

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
  markdown.appendMarkdown(`Value type: \`${info.valueType}\``);
  if (info.defaultValue !== undefined) {
    markdown.appendMarkdown(`\n\nDefault: \`${info.defaultValue}\``);
  }
  if (info.appliesTo.length > 0) {
    markdown.appendMarkdown(`\n\nApplies to: ${info.appliesTo.map(value => `\`${value}\``).join(", ")}`);
  }
  if (info.aliases.length > 0) {
    markdown.appendMarkdown(`\n\nAliases: ${info.aliases.map(value => `\`${value}\``).join(", ")}`);
  }
  if (info.citResewnOnly) {
    markdown.appendMarkdown("\n\nCIT Resewn only.");
  }
  return markdown;
}

function toVsCodeRange(range: CitHoverInfo["range"]): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  );
}
