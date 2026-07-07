import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { isValidMinecraftNamespace } from "../../packages/mc-assets/src";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { getCitDocumentNamespace } from "../cit/citPaths";
import {
  inferIncompleteResourceCompletionContext,
  ResourceCompletionTextRange
} from "../utils/resourceCompletionContext";
import {
  buildResourceCompletionText,
  filterExistingResourceRoots,
  getAssetsRootCandidates,
  parsePartialResourcePath,
  PartialResourcePath,
  shouldCompleteNamespaces,
  splitResourcePath
} from "../utils/resourceCompletionPaths";
import { findResourceReferenceAtPosition, ResourceReference } from "../utils/resourceReferences";
import { getDocumentResourceRootCandidates } from "../../packages/mc-assets/src";
import { rangeInsideString } from "../utils/resourceRange";

interface ResourceCompletionContext {
  reference: ResourceReference;
  replacementRange: vscode.Range;
  includeQuotes: boolean;
}

export const triggerResourceCompletionCommand = "McResHelper.triggerResourceCompletion";

const resourceCompletionProvider: vscode.CompletionItemProvider = {
  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
    const context = getResourceCompletionContext(document, position);
    if (!context || context.reference.value.startsWith("#")) {
      return null;
    }

    const partialPath = parsePartialResourcePath(context.reference.value);
    const lookupNamespace = getCompletionLookupNamespace(document.fileName, context.reference, partialPath);
    const defaultAssetsPath = vscode.workspace.getConfiguration().get<string>("McResHelper.defaultMcAssetsPath");
    const resourcePackRoots = vscode.workspace.getConfiguration().get<string[]>("McResHelper.resourcePackLoadOrder") ?? [];
    const roots = getDocumentResourceRootCandidates(
      document.fileName,
      context.reference.source,
      defaultAssetsPath,
      lookupNamespace,
      context.reference.target,
      {
        pathExists: fileName => workspaceResourceCache.getPathExists(fileName),
        getPackRoot: fileName => workspaceResourceCache.getPackRoot(fileName),
        getPackMetadata: packRoot => workspaceResourceCache.getPackMetadata(packRoot),
        resourcePackRoots
      }
    );
    if (context.reference.resolveMode === "cit" && shouldCompleteCitLocalPath(context.reference.value)) {
      roots.unshift(path.dirname(document.fileName));
    }
    const items = await collectCompletionItems(roots, partialPath, context);

    return items.length > 0 ? items : null;
  }
};

export default resourceCompletionProvider;

function getResourceCompletionContext(document: vscode.TextDocument, position: vscode.Position): ResourceCompletionContext | null {
  const reference = findResourceReferenceAtPosition(document, position);
  if (reference) {
    const replacementRange = rangeInsideString(reference.valueNode);
    return replacementRange ? { reference, replacementRange, includeQuotes: false } : null;
  }

  const inferredContext = inferIncompleteResourceCompletionContext(document, position);
  if (!inferredContext) {
    return null;
  }

  return {
    reference: inferredContext.reference,
    replacementRange: rangeFromTextRange(inferredContext.replacementRange),
    includeQuotes: inferredContext.includeQuotes
  };
}

function rangeFromTextRange(range: ResourceCompletionTextRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  );
}

function getCompletionLookupNamespace(
  fileName: string,
  reference: ResourceReference,
  partialPath: PartialResourcePath
): string {
  if (reference.resolveMode === "cit" && !partialPath.explicitNamespace) {
    return getCitDocumentNamespace(fileName);
  }

  return partialPath.namespace;
}

function shouldCompleteCitLocalPath(value: string): boolean {
  const cleanValue = value.trim();
  if (cleanValue.length === 0) {
    return true;
  }

  return !path.isAbsolute(cleanValue) &&
    !cleanValue.includes(":") &&
    !startsWithPathSegment(cleanValue, "assets");
}

function startsWithPathSegment(value: string, segment: string): boolean {
  const normalizedValue = value.replace(/[\\/]+/g, path.sep);
  const [firstSegment] = normalizedValue.split(path.sep);
  return firstSegment?.toLowerCase() === segment.toLowerCase();
}

async function collectCompletionItems(
  roots: string[],
  partialPath: PartialResourcePath,
  context: ResourceCompletionContext
): Promise<vscode.CompletionItem[]> {
  const itemsByInsertText = new Map<string, vscode.CompletionItem>();

  await collectNamespaceCompletionItems(itemsByInsertText, roots, partialPath, context);

  for (const root of roots) {
    const directoryPath = path.join(root, ...splitResourcePath(partialPath.directory));
    const entries = await workspaceResourceCache.getDirectoryEntries(directoryPath);
    if (!entries) {
      continue;
    }

    for (const entry of entries) {
      if (!isCompletableEntry(entry, context.reference)) {
        continue;
      }

      const label = entry.isDirectory() ? entry.name : stripExtension(entry.name, context.reference.extension);
      if (!label.startsWith(partialPath.prefix)) {
        continue;
      }

      const completionText = buildResourceCompletionText(partialPath, label, entry.isDirectory());
      if (itemsByInsertText.has(completionText.value)) {
        continue;
      }

      const item = new vscode.CompletionItem(
        label,
        entry.isDirectory() ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
      );
      item.range = context.replacementRange;
      item.filterText = completionText.filterText;
      item.insertText = buildCompletionInsertText(completionText.value, context.includeQuotes, entry.isDirectory());
      if (entry.isDirectory()) {
        item.command = createTriggerSuggestCommand();
      }
      itemsByInsertText.set(completionText.value, item);
    }
  }

  return [...itemsByInsertText.values()].sort((left, right) => left.label.toString().localeCompare(right.label.toString()));
}

async function collectNamespaceCompletionItems(
  itemsByInsertText: Map<string, vscode.CompletionItem>,
  roots: string[],
  partialPath: PartialResourcePath,
  context: ResourceCompletionContext
): Promise<void> {
  if (!shouldCompleteNamespaces(partialPath)) {
    return;
  }

  const existingRoots = await filterExistingResourceRoots(
    roots,
    async root => Boolean(await workspaceResourceCache.getDirectoryEntries(root))
  );
  for (const assetsRoot of getAssetsRootCandidates(existingRoots, partialPath.namespace, context.reference.target)) {
    const entries = await workspaceResourceCache.getDirectoryEntries(assetsRoot);
    if (!entries) {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidMinecraftNamespace(entry.name)) {
        continue;
      }

      const label = `${entry.name}:`;
      if (!label.startsWith(partialPath.prefix) || itemsByInsertText.has(label)) {
        continue;
      }

      const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Module);
      item.range = context.replacementRange;
      item.filterText = label;
      item.insertText = buildCompletionInsertText(label, context.includeQuotes, true);
      item.command = createTriggerSuggestCommand();
      itemsByInsertText.set(label, item);
    }
  }
}

function createTriggerSuggestCommand(): vscode.Command {
  return { command: triggerResourceCompletionCommand, title: vscode.l10n.t("Suggest") };
}

function buildCompletionInsertText(value: string, includeQuotes: boolean, keepCursorInsideQuotes: boolean): string | vscode.SnippetString {
  if (!includeQuotes) {
    return value;
  }

  const escapedValue = escapeSnippet(value);
  return new vscode.SnippetString(keepCursorInsideQuotes ? `"${escapedValue}$0"` : `"${escapedValue}"$0`);
}

function escapeSnippet(value: string): string {
  return value.replace(/[\\$}]/g, "\\$&");
}

function stripExtension(fileName: string, extension: string | null): string {
  return extension && fileName.endsWith(`.${extension}`) ? fileName.slice(0, -extension.length - 1) : fileName;
}

function isCompletableEntry(entry: Dirent, reference: ResourceReference): boolean {
  if (reference.kind === "fontFile") {
    return entry.isDirectory() || entry.isFile();
  }

  if (reference.kind === "shader" && reference.extension === null) {
    return entry.isDirectory() || (entry.isFile() && isShaderSourceFile(entry.name));
  }

  if (reference.extension === null) {
    return entry.isDirectory();
  }

  return entry.isDirectory() || (entry.isFile() && entry.name.endsWith(`.${reference.extension}`));
}

function isShaderSourceFile(fileName: string): boolean {
  return /\.(?:glsl|vsh|fsh)$/i.test(fileName);
}
