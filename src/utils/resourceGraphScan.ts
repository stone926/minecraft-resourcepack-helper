import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { getAssetsRootPathCandidates } from "../../packages/mc-assets/src";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { getResourceConfiguration } from "./resourceConfiguration";
import { isModelDocumentPath, resourceUriKey } from "./resourceGraphSearch";
import { isResourceReferenceFileName } from "./resourceReferences";

export async function collectResourceReferenceUris(): Promise<vscode.Uri[]> {
  const urisByKey = new Map<string, vscode.Uri>();
  const workspaceUris = [
    ...(await vscode.workspace.findFiles("**/assets/**/*.json", "**/node_modules/**")),
    ...(await vscode.workspace.findFiles("**/assets/**/*.properties", "**/node_modules/**")),
    ...(await vscode.workspace.findFiles("**/assets/*/shaders/**/*.vsh", "**/node_modules/**")),
    ...(await vscode.workspace.findFiles("**/assets/*/shaders/**/*.fsh", "**/node_modules/**")),
    ...(await vscode.workspace.findFiles("**/assets/*/shaders/**/*.glsl", "**/node_modules/**"))
  ];

  for (const uri of workspaceUris) {
    if (isResourceReferenceFileName(uri.fsPath)) {
      urisByKey.set(resourceUriKey(uri), uri);
    }
  }

  for (const root of await getConfiguredAssetsRoots()) {
    for (const uri of await collectResourceReferenceUrisInRoot(root)) {
      urisByKey.set(resourceUriKey(uri), uri);
    }
  }

  return [...urisByKey.values()];
}

export async function collectWorkspaceBlockstateUris(): Promise<vscode.Uri[]> {
  return vscode.workspace.findFiles("**/assets/*/blockstates/*.json", "**/node_modules/**");
}

export async function collectModelDocumentUris(): Promise<vscode.Uri[]> {
  const urisByKey = new Map<string, vscode.Uri>();
  const workspaceUris = [
    ...(await vscode.workspace.findFiles("**/assets/*/models/**/*.json", "**/node_modules/**"))
  ];

  for (const uri of workspaceUris) {
    urisByKey.set(resourceUriKey(uri), uri);
  }

  for (const root of await getConfiguredAssetsRoots()) {
    for (const uri of await collectResourceReferenceUrisInRoot(root)) {
      if (isModelDocumentPath(uri.fsPath)) {
        urisByKey.set(resourceUriKey(uri), uri);
      }
    }
  }

  return [...urisByKey.values()];
}

async function getConfiguredAssetsRoots(): Promise<string[]> {
  const { defaultAssetsPath, resourcePackRoots } = getResourceConfiguration();
  const configuredPackRoots = resourcePackRoots ?? [];
  const candidates = [
    ...configuredPackRoots.flatMap(root => getAssetsRootPathCandidates(root)),
    ...(defaultAssetsPath ? getAssetsRootPathCandidates(defaultAssetsPath) : [])
  ];

  const roots: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        roots.push(candidate);
      }
    } catch {
      // Ignore invalid configuration paths here; diagnostics already surface unresolved references.
    }
  }

  return roots;
}

async function collectResourceReferenceUrisInRoot(directory: string): Promise<vscode.Uri[]> {
  const uris: vscode.Uri[] = [];
  await collectResourceReferenceUrisInto(directory, uris);
  return uris;
}

async function collectResourceReferenceUrisInto(directory: string, uris: vscode.Uri[]): Promise<void> {
  const entries = await workspaceResourceCache.getDirectoryEntries(directory);
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) {
        await collectResourceReferenceUrisInto(entryPath, uris);
      }
    } else if (entry.isFile() && isResourceReferenceFileName(entryPath)) {
      uris.push(vscode.Uri.file(entryPath));
    }
  }
}

function shouldSkipDirectory(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === "out";
}
