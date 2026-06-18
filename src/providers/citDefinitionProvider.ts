import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export default (document: vscode.TextDocument, position: vscode.Position) => {
  const lineText = document.lineAt(position.line).text.trim();
  const separatorIndex = lineText.indexOf("=");
  if (separatorIndex < 1) {
    return null;
  }

  const key = lineText.slice(0, separatorIndex).trim();
  const value = lineText.slice(separatorIndex + 1).trim();
  const resourceType = getResourceType(key);
  if (!resourceType || value.length === 0) {
    return null;
  }

  const resolvedPath = resolveCitPath(document, value, resourceType);
  if (resolvedPath && fs.existsSync(resolvedPath)) {
    return new vscode.Location(vscode.Uri.file(resolvedPath), new vscode.Position(0, 0));
  }

  return null;
};

function getResourceType(key: string): "textures" | "models" | null {
  if (/^texture(\.|$)/.test(key)) {
    return "textures";
  }

  if (/^model(\.|$)/.test(key)) {
    return "models";
  }

  return null;
}

function resolveCitPath(document: vscode.TextDocument, value: string, resourceType: "textures" | "models"): string | null {
  const cleanValue = value.replace(/^minecraft:/, "");
  const extension = resourceType === "textures" ? ".png" : ".json";
  let resolvedPath = "";

  if (cleanValue.includes("/") || cleanValue.includes("\\")) {
    if (cleanValue.startsWith("assets/") || cleanValue.startsWith("assets\\")) {
      resolvedPath = path.join(getWorkspaceRoot(), cleanValue);
    } else {
      resolvedPath = path.join(getWorkspaceRoot(), "assets", "minecraft", resourceType, cleanValue);
    }
  } else {
    resolvedPath = path.join(path.dirname(document.fileName), cleanValue);
  }

  if (path.extname(resolvedPath) === "") {
    resolvedPath += extension;
  }

  return resolvedPath;
}

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
}
