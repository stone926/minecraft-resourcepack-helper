import { resourceProjectAnchorWatcherGlob } from "../../packages/resource-project/src";
import { uniqueValues } from "../../packages/mc-assets/src";
import * as vscode from "vscode";
import { ResourcePackProjectService } from "../resourceProject/resourcePackProjectService";
import { VscodeResourcePackProjectHost } from "../resourceProject/vscodeResourceProjectHost";
import { ResourceUniverseService } from "../resourceUniverse/core/resourceUniverseService";
import { PhysicalAssetContributionProvider } from "../resourceUniverse/providers/physicalAssetProvider";
import { VscodePhysicalAssetSource } from "../resourceUniverse/providers/vscodePhysicalAssetSource";
import { LazyVscodeArchiveResources } from "../resourceUniverse/virtualFs/lazyVscodeArchiveResources";
import { affectsResourceResolutionConfiguration } from "../utils/resourceConfigurationKeys";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigation";
import { ResourceUniverseNavigationFacade } from "../services/resourceUniverseNavigationFacade";

export interface ResourceInfrastructure extends vscode.Disposable {
  readonly projects: ResourcePackProjectService;
  readonly universe: ResourceUniverseService;
  readonly navigation: ResourceUniverseNavigation;
}

/**
 * Creates the concrete project/universe infrastructure without transferring
 * ownership to an extension context. Lazy composition uses this factory only
 * after a real resource query, then owns disposal itself.
 */
export function createResourceInfrastructure(): ResourceInfrastructure {
  const projects = new ResourcePackProjectService(new VscodeResourcePackProjectHost());
  const universe = new ResourceUniverseService();
  const navigation = new ResourceUniverseNavigationFacade(projects, universe);
  const archiveResources = new LazyVscodeArchiveResources(
    vscode,
    uri => navigation.invalidateUri(uri)
  );
  const physicalSource = new VscodePhysicalAssetSource(projects, archiveResources);
  navigation.setPhysicalDefinitionResolver(physicalSource);
  const physicalProvider = universe.registerProvider(new PhysicalAssetContributionProvider(
    physicalSource
  ));
  const disposables: vscode.Disposable[] = [
    physicalProvider,
    archiveResources
  ];

  const metadataWatcher = vscode.workspace.createFileSystemWatcher(
    resourceProjectAnchorWatcherGlob
  );
  metadataWatcher.onDidCreate(invalidateMetadata, null, disposables);
  metadataWatcher.onDidChange(invalidateMetadata, null, disposables);
  metadataWatcher.onDidDelete(invalidateMetadata, null, disposables);
  disposables.push(metadataWatcher);
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
    dispose: () => {
      for (const disposable of disposables.splice(0)) {
        disposable.dispose();
      }
      projects.dispose();
      universe.dispose();
    }
  };
  return registration;

  function invalidateMetadata(uri: vscode.Uri): void {
    invalidateProjects(projects.invalidateUri(uri.toString()));
  }

  function invalidateProjects(projectIds: readonly string[]): void {
    const uniqueProjectIds = uniqueValues(projectIds);
    physicalSource.invalidateProjects(uniqueProjectIds);
    for (const projectId of uniqueProjectIds) {
      universe.removeProject(projectId);
    }
  }
}
