import * as vscode from "vscode";
import { ResourcePackProjectService } from "../resourceProject";
import { VscodeResourcePackProjectHost } from "../resourceProject/vscodeResourceProjectHost";
import {
  ArchiveResourceStore,
  PhysicalAssetContributionProvider,
  readOnlyArchiveResourceScheme,
  ResourceUniverseService
} from "../resourceUniverse";
import { VscodePhysicalAssetSource } from "../resourceUniverse/providers/vscodePhysicalAssetSource";
import {
  VscodeArchiveResourceSourceHost,
  VscodeArchiveResourceSourceWatcher,
  VscodeReadOnlyArchiveFileSystemProvider
} from "../resourceUniverse/virtualFs/vscodeReadOnlyArchiveFileSystem";
import { affectsResourceResolutionConfiguration } from "../utils/resourceConfigurationKeys";
import { ResourceUniverseNavigationFacade } from "../services/resourceUniverseNavigationFacade";

export interface ResourceInfrastructure extends vscode.Disposable {
  readonly projects: ResourcePackProjectService;
  readonly universe: ResourceUniverseService;
  readonly navigation: ResourceUniverseNavigationFacade;
  readonly archiveResources: ArchiveResourceStore;
}

/**
 * Main-extension composition seam for project/universe infrastructure. It
 * registers only lightweight metadata watchers; provider scans stay on demand.
 */
export function registerResourceInfrastructure(
  context: vscode.ExtensionContext
): ResourceInfrastructure {
  const projects = new ResourcePackProjectService(new VscodeResourcePackProjectHost());
  const universe = new ResourceUniverseService();
  const archiveResources = new ArchiveResourceStore(new VscodeArchiveResourceSourceHost());
  const archiveFileSystem = new VscodeReadOnlyArchiveFileSystemProvider(archiveResources);
  const archiveFileSystemRegistration = vscode.workspace.registerFileSystemProvider(
    readOnlyArchiveResourceScheme,
    archiveFileSystem,
    { isCaseSensitive: true, isReadonly: true }
  );
  const physicalProvider = universe.registerProvider(new PhysicalAssetContributionProvider(
    new VscodePhysicalAssetSource(projects, archiveResources)
  ));
  const navigation = new ResourceUniverseNavigationFacade(projects, universe);
  const archiveSourceWatcher = new VscodeArchiveResourceSourceWatcher(
    archiveResources,
    uri => navigation.invalidateUri(uri)
  );
  const disposables: vscode.Disposable[] = [
    physicalProvider,
    archiveSourceWatcher,
    archiveFileSystemRegistration,
    archiveFileSystem,
    archiveResources
  ];

  for (const pattern of ["**/rsgl.config.json", "**/pack.mcmeta"]) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(invalidateMetadata, null, disposables);
    watcher.onDidChange(invalidateMetadata, null, disposables);
    watcher.onDidDelete(invalidateMetadata, null, disposables);
    disposables.push(watcher);
  }
  disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!affectsResourceResolutionConfiguration(event)) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const projectIds = folders.length === 0
      ? projects.invalidateWorkspaceConfiguration()
      : folders.flatMap(folder => projects.invalidateWorkspaceConfiguration(folder.uri.toString()));
    invalidateProjects(projectIds);
  }));

  const registration: ResourceInfrastructure = {
    projects,
    universe,
    navigation,
    archiveResources,
    dispose: () => {
      for (const disposable of disposables.splice(0)) {
        disposable.dispose();
      }
      projects.dispose();
      universe.dispose();
    }
  };
  context.subscriptions.push(registration);
  return registration;

  function invalidateMetadata(uri: vscode.Uri): void {
    invalidateProjects(projects.invalidateUri(uri.toString()));
  }

  function invalidateProjects(projectIds: readonly string[]): void {
    for (const projectId of new Set(projectIds)) {
      universe.removeProject(projectId);
    }
  }
}
