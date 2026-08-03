import * as fs from "node:fs";
import * as vscode from "vscode";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import type { ModelPreviewFileSystem } from "../model/ModelDocument";
import { findByNormalizedPath, type PackMetadata } from "../../../packages/mc-assets/src";

export class ModelPreviewHostFileSystem implements ModelPreviewFileSystem {
  async readTextFile(fileName: string): Promise<string> {
    const document = findOpenTextDocument(fileName);
    if (document) {
      return document.getText();
    }

    return fs.promises.readFile(fileName, "utf8");
  }

  async readBinaryFile(fileName: string): Promise<Uint8Array> {
    return fs.promises.readFile(fileName);
  }

  fileExists(fileName: string): boolean {
    return workspaceResourceCache.getPathExists(fileName);
  }

  getResourceGeneration(): number {
    return workspaceResourceCache.getResourceMutationGeneration();
  }

  hasAnyResourceChangedSince(generation: number, fileNames: readonly string[]): boolean {
    return workspaceResourceCache.hasAnyResourceChangedSince(generation, fileNames);
  }

  fileVersion(fileName: string): string | null {
    return workspaceResourceCache.getFileVersion(fileName);
  }

  getPackRoot(fileName: string): string | null {
    return workspaceResourceCache.getPackRoot(fileName);
  }

  getPackMetadata(packRoot: string): PackMetadata {
    return workspaceResourceCache.getPackMetadata(packRoot);
  }
}

function findOpenTextDocument(fileName: string): vscode.TextDocument | null {
  return findByNormalizedPath(
    vscode.workspace.textDocuments,
    fileName,
    document => document.uri.scheme === "file" ? document.fileName : null
  ) ?? null;
}
