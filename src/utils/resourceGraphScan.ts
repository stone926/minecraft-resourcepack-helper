import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { getAssetsRootPathCandidates, uniqueValues } from "../../packages/mc-assets/src";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { getResourceGraphDiscoveryGlob } from "../resources/resourceSurfaceRegistry";
import { getResourceConfiguration } from "./resourceConfiguration";
import { resourceUriKey } from "./resourceGraphSearch";
import {
  classifyResourceGraphPaths,
  collectResourceGraphPathsInRoot,
  resourceGraphConfiguredRootMaxDepth,
  type ResourceGraphPathSnapshot
} from "./resourceGraphScanCore";

export interface ResourceGraphWorkspaceSnapshot {
  readonly resourceReferenceUris: vscode.Uri[];
  readonly modelDocumentUris: vscode.Uri[];
  readonly blockstateUris: vscode.Uri[];
}

export async function collectResourceGraphWorkspaceSnapshot(): Promise<ResourceGraphWorkspaceSnapshot> {
  const workspaceUris = await vscode.workspace.findFiles(
    getResourceGraphDiscoveryGlob(),
    "**/node_modules/**"
  );
  const workspaceSnapshot = classifyResourceGraphPaths(
    workspaceUris.map(uri => uri.fsPath),
    { includeBlockstates: true }
  );
  const configuredSnapshots = await Promise.all((await getConfiguredAssetsRoots()).map(root =>
    collectResourceGraphPathsInRoot(
      root,
      directory => workspaceResourceCache.getDirectoryEntries(directory),
      { maxDepth: resourceGraphConfiguredRootMaxDepth }
    )
  ));

  return {
    resourceReferenceUris: mergeSnapshotUris(
      workspaceSnapshot,
      configuredSnapshots,
      "resourceReferencePaths"
    ),
    modelDocumentUris: mergeSnapshotUris(workspaceSnapshot, configuredSnapshots, "modelDocumentPaths"),
    // Preserve the existing Blocks view scope: only workspace blockstates are listed.
    blockstateUris: uniqueUris(workspaceSnapshot.blockstatePaths.map(fileName => vscode.Uri.file(fileName)))
  };
}

async function getConfiguredAssetsRoots(): Promise<string[]> {
  const { defaultAssetsPath, resourcePackRoots } = getResourceConfiguration();
  const configuredPackRoots = resourcePackRoots ?? [];
  const candidates = [
    ...configuredPackRoots.flatMap(root => getAssetsRootPathCandidates(root)),
    ...(defaultAssetsPath ? getAssetsRootPathCandidates(defaultAssetsPath) : [])
  ];

  const roots: string[] = [];
  for (const candidate of uniqueValues(candidates)) {
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

function mergeSnapshotUris(
  workspaceSnapshot: ResourceGraphPathSnapshot,
  configuredSnapshots: readonly ResourceGraphPathSnapshot[],
  key: "resourceReferencePaths" | "modelDocumentPaths"
): vscode.Uri[] {
  return uniqueUris([
    ...workspaceSnapshot[key],
    ...configuredSnapshots.flatMap(snapshot => snapshot[key])
  ].map(fileName => vscode.Uri.file(fileName)));
}

function uniqueUris(uris: readonly vscode.Uri[]): vscode.Uri[] {
  const byKey = new Map<string, vscode.Uri>();
  for (const uri of uris) {
    byKey.set(resourceUriKey(uri), uri);
  }
  return [...byKey.values()];
}
