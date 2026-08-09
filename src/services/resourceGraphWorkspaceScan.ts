import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { getAssetsRootPathCandidates, uniqueValues } from "../../packages/mc-assets/src";
import {
  getIgnoredWorkspaceGlob,
  getResourceGraphDiscoveryGlob
} from "../resources/resourceSurfaceRegistry";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import {
  collectResourceGraphWorkspacePathSnapshot,
  type ResourceGraphScanHost
} from "../utils/resourceGraphScan";
import { resourceUriKey } from "../utils/resourceGraphSearch";
import { workspaceResourceCache } from "./workspaceResourceCache";

export interface ResourceGraphWorkspaceSnapshot {
  readonly resourceReferenceUris: vscode.Uri[];
  readonly modelDocumentUris: vscode.Uri[];
  readonly blockstateUris: vscode.Uri[];
}

export async function collectResourceGraphWorkspaceSnapshot(
  host: ResourceGraphScanHost = defaultResourceGraphScanHost
): Promise<ResourceGraphWorkspaceSnapshot> {
  const snapshot = await collectResourceGraphWorkspacePathSnapshot(host);
  return {
    resourceReferenceUris: uniqueUris(snapshot.resourceReferencePaths.map(fileName =>
      vscode.Uri.file(fileName)
    )),
    modelDocumentUris: uniqueUris(snapshot.modelDocumentPaths.map(fileName =>
      vscode.Uri.file(fileName)
    )),
    blockstateUris: uniqueUris(snapshot.blockstatePaths.map(fileName => vscode.Uri.file(fileName)))
  };
}

const defaultResourceGraphScanHost: ResourceGraphScanHost = {
  async findWorkspaceResourcePaths(): Promise<string[]> {
    const uris = await vscode.workspace.findFiles(
      getResourceGraphDiscoveryGlob(),
      getIgnoredWorkspaceGlob()
    );
    return uris.map(uri => uri.fsPath);
  },
  getConfiguredAssetsRoots,
  getDirectoryEntries: directory => workspaceResourceCache.getDirectoryEntries(directory)
};

async function getConfiguredAssetsRoots(): Promise<string[]> {
  const { defaultAssetsPath, resourcePackRoots } = getResourceConfiguration();
  const candidates = [
    ...(resourcePackRoots ?? []).flatMap(root => getAssetsRootPathCandidates(root)),
    ...(defaultAssetsPath ? getAssetsRootPathCandidates(defaultAssetsPath) : [])
  ];

  const roots: string[] = [];
  for (const candidate of uniqueValues(candidates)) {
    try {
      if ((await fs.stat(candidate)).isDirectory()) {
        roots.push(candidate);
      }
    } catch {
      // Invalid configuration paths are handled by unresolved-reference diagnostics.
    }
  }
  return roots;
}

function uniqueUris(uris: readonly vscode.Uri[]): vscode.Uri[] {
  const byKey = new Map<string, vscode.Uri>();
  for (const uri of uris) {
    byKey.set(resourceUriKey(uri), uri);
  }
  return [...byKey.values()];
}
