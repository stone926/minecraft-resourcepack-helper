import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getCitPathCandidates, getCitResourceType } from '../utils/citPaths';

export default (document: vscode.TextDocument, position: vscode.Position) => {
  const lineText = document.lineAt(position.line).text.trim();
  const separatorIndex = lineText.indexOf("=");
  if (separatorIndex < 1) {
    return null;
  }

  const key = lineText.slice(0, separatorIndex).trim();
  const value = lineText.slice(separatorIndex + 1).trim();
  const resourceType = getCitResourceType(key);
  if (!resourceType || value.length === 0) {
    return null;
  }

  for (const resolvedPath of getCitPathCandidates(document.fileName, getPackRoot(document), value, resourceType)) {
    if (fs.existsSync(resolvedPath)) {
      return new vscode.Location(vscode.Uri.file(resolvedPath), new vscode.Position(0, 0));
    }
  }

  return null;
};

function getPackRoot(document: vscode.TextDocument): string {
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? getWorkspaceRoot();
  let currentDirectory = path.dirname(document.fileName);

  while (currentDirectory.startsWith(workspaceRoot)) {
    if (fs.existsSync(path.join(currentDirectory, "pack.mcmeta"))) {
      return currentDirectory;
    }

    const parent = path.dirname(currentDirectory);
    if (parent === currentDirectory) {
      break;
    }
    currentDirectory = parent;
  }

  return workspaceRoot;
}

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
}
