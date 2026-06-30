import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ModelPreviewFileSystem } from "../model/ModelDocument";
import { fileNameKey } from "../resolve/ResourceDependencyResolver";

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
    return fs.existsSync(fileName);
  }

  fileVersion(fileName: string): string | null {
    const document = findOpenTextDocument(fileName);
    if (document) {
      return `open:${document.version}`;
    }

    try {
      const stat = fs.statSync(fileName);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }
}

function findOpenTextDocument(fileName: string): vscode.TextDocument | null {
  const key = fileNameKey(path.normalize(fileName));
  return vscode.workspace.textDocuments.find(document =>
    document.uri.scheme === "file" && fileNameKey(document.uri.fsPath) === key
  ) ?? null;
}
