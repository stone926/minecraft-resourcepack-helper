import {
  classifyResourceGraphPaths,
  collectResourceGraphPathsInRoot,
  resourceGraphConfiguredRootMaxDepth,
  type ResourceGraphDirectoryEntry,
  type ResourceGraphPathSnapshot
} from "./resourceGraphScanCore";

export interface ResourceGraphScanHost {
  findWorkspaceResourcePaths(): Promise<readonly string[]>;
  getConfiguredAssetsRoots(): Promise<readonly string[]>;
  getDirectoryEntries(
    directory: string
  ): Promise<readonly ResourceGraphDirectoryEntry[] | null>;
}

/** Pure orchestration over the filesystem/discovery capabilities supplied by the host. */
export async function collectResourceGraphWorkspacePathSnapshot(
  host: ResourceGraphScanHost
): Promise<ResourceGraphPathSnapshot> {
  const [workspacePaths, configuredRoots] = await Promise.all([
    host.findWorkspaceResourcePaths(),
    host.getConfiguredAssetsRoots()
  ]);
  const workspaceSnapshot = classifyResourceGraphPaths(workspacePaths, {
    includeBlockstates: true
  });
  const configuredSnapshots = await Promise.all(configuredRoots.map(root =>
    collectResourceGraphPathsInRoot(
      root,
      directory => host.getDirectoryEntries(directory),
      { maxDepth: resourceGraphConfiguredRootMaxDepth }
    )
  ));

  return {
    resourceReferencePaths: mergeSnapshotPaths(
      workspaceSnapshot,
      configuredSnapshots,
      "resourceReferencePaths"
    ),
    modelDocumentPaths: mergeSnapshotPaths(
      workspaceSnapshot,
      configuredSnapshots,
      "modelDocumentPaths"
    ),
    // Preserve the existing Blocks view scope: configured vanilla roots are not listed.
    blockstatePaths: [...workspaceSnapshot.blockstatePaths]
  };
}

function mergeSnapshotPaths(
  workspaceSnapshot: ResourceGraphPathSnapshot,
  configuredSnapshots: readonly ResourceGraphPathSnapshot[],
  key: "resourceReferencePaths" | "modelDocumentPaths"
): string[] {
  return [
    ...workspaceSnapshot[key],
    ...configuredSnapshots.flatMap(snapshot => snapshot[key])
  ];
}
