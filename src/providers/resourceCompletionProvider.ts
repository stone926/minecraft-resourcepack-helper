import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { findResourceReferenceAtPosition, ResourceReference } from "../utils/resourceReferences";
import { getDocumentResourceRootCandidates } from "../utils/resourceLocation";
import { rangeInsideString } from "../utils/resourceRange";

interface PartialResourcePath {
  namespace: string;
  explicitNamespace: boolean;
  directory: string;
  prefix: string;
}

const resourceCompletionProvider: vscode.CompletionItemProvider = {
  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
    const reference = findResourceReferenceAtPosition(document, position);
    if (!reference || reference.value.startsWith("#")) {
      return null;
    }

    const replacementRange = rangeInsideString(reference.valueNode);
    if (!replacementRange) {
      return null;
    }

    const partialPath = parsePartialResourcePath(reference.value);
    const defaultAssetsPath = vscode.workspace.getConfiguration().get<string>("McResHelper.defaultMcAssetsPath");
    const roots = getDocumentResourceRootCandidates(
      document.fileName,
      reference.source,
      defaultAssetsPath,
      partialPath.namespace,
      reference.target
    );
    const items = await collectCompletionItems(roots, partialPath, reference, replacementRange);

    return items.length > 0 ? items : null;
  }
};

export default resourceCompletionProvider;

async function collectCompletionItems(
  roots: string[],
  partialPath: PartialResourcePath,
  reference: ResourceReference,
  replacementRange: vscode.Range
): Promise<vscode.CompletionItem[]> {
  const itemsByInsertText = new Map<string, vscode.CompletionItem>();

  for (const root of roots) {
    const directoryPath = path.join(root, ...splitResourcePath(partialPath.directory));
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!isCompletableEntry(entry, reference)) {
        continue;
      }

      const label = entry.isDirectory() ? entry.name : stripExtension(entry.name, reference.extension);
      if (!label.startsWith(partialPath.prefix)) {
        continue;
      }

      const insertText = buildInsertText(partialPath, label, entry.isDirectory());
      if (itemsByInsertText.has(insertText)) {
        continue;
      }

      const item = new vscode.CompletionItem(
        label,
        entry.isDirectory() ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
      );
      item.range = replacementRange;
      item.insertText = insertText;
      if (entry.isDirectory()) {
        item.command = { command: "editor.action.triggerSuggest", title: vscode.l10n.t("Suggest") };
      }
      itemsByInsertText.set(insertText, item);
    }
  }

  return [...itemsByInsertText.values()].sort((left, right) => left.label.toString().localeCompare(right.label.toString()));
}

function parsePartialResourcePath(value: string): PartialResourcePath {
  const namespaceSeparator = value.indexOf(":");
  const explicitNamespace = namespaceSeparator >= 0;
  const namespace = explicitNamespace ? value.slice(0, namespaceSeparator) || "minecraft" : "minecraft";
  const resourcePath = explicitNamespace ? value.slice(namespaceSeparator + 1) : value;
  const slashIndex = Math.max(resourcePath.lastIndexOf("/"), resourcePath.lastIndexOf("\\"));

  if (slashIndex < 0) {
    return {
      namespace,
      explicitNamespace,
      directory: "",
      prefix: resourcePath
    };
  }

  return {
    namespace,
    explicitNamespace,
    directory: resourcePath.slice(0, slashIndex),
    prefix: resourcePath.slice(slashIndex + 1)
  };
}

function buildInsertText(partialPath: PartialResourcePath, label: string, isDirectory: boolean): string {
  const namespacePrefix = partialPath.explicitNamespace || partialPath.namespace !== "minecraft" ? `${partialPath.namespace}:` : "";
  const directoryPrefix = partialPath.directory.length > 0 ? `${partialPath.directory.replaceAll("\\", "/")}/` : "";
  return `${namespacePrefix}${directoryPrefix}${label}${isDirectory ? "/" : ""}`;
}

function splitResourcePath(value: string): string[] {
  return value.split(/[\\/]+/).filter(Boolean);
}

function stripExtension(fileName: string, extension: string | null): string {
  return extension && fileName.endsWith(`.${extension}`) ? fileName.slice(0, -extension.length - 1) : fileName;
}

function isCompletableEntry(entry: Dirent, reference: ResourceReference): boolean {
  if (reference.kind === "fontFile") {
    return entry.isDirectory() || entry.isFile();
  }

  if (reference.extension === null) {
    return entry.isDirectory();
  }

  return entry.isDirectory() || (entry.isFile() && entry.name.endsWith(`.${reference.extension}`));
}
