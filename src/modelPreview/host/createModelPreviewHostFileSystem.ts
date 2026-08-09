import * as fs from "node:fs";
import * as vscode from "vscode";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import { ModelPreviewHostFileSystem } from "./ModelPreviewHostFileSystem";

/** Wires the VS Code workspace and shared resource cache into the preview file-system bridge. */
export function createModelPreviewHostFileSystem(): ModelPreviewHostFileSystem {
  return new ModelPreviewHostFileSystem({
    getOpenTextDocuments: () => vscode.workspace.textDocuments,
    readTextFile: fileName => fs.promises.readFile(fileName, "utf8"),
    readBinaryFile: fileName => fs.promises.readFile(fileName),
    fileExists: fileName => workspaceResourceCache.getPathExists(fileName),
    getResourceGeneration: () => workspaceResourceCache.getResourceMutationGeneration(),
    hasAnyResourceChangedSince: (generation, fileNames) =>
      workspaceResourceCache.hasAnyResourceChangedSince(generation, fileNames),
    fileVersion: fileName => workspaceResourceCache.getFileVersion(fileName),
    getPackRoot: fileName => workspaceResourceCache.getPackRoot(fileName),
    getPackMetadata: packRoot => workspaceResourceCache.getPackMetadata(packRoot)
  });
}
