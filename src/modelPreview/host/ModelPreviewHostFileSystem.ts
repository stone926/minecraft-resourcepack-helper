import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import type { ModelPreviewFileSystem } from "../model/ModelDocument";
import { normalizePathKey, type PackMetadata } from "../../../packages/mc-assets/src";

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
  const key = normalizePathKey(path.normalize(fileName));
  return vscode.workspace.textDocuments.find(document =>
    document.uri.scheme === "file" && normalizePathKey(document.uri.fsPath) === key
  ) ?? null;
}
