import * as vscode from "vscode";
import { ResourcePackProjectService } from "../resourceProject";
import { VscodeResourcePackProjectHost } from "../resourceProject/vscodeResourceProjectHost";
import {
  PhysicalAssetContributionProvider,
  ResourceUniverseService
} from "../resourceUniverse";
import { VscodePhysicalAssetSource } from "../resourceUniverse/providers/vscodePhysicalAssetSource";
import { LazyVscodeArchiveResources } from "../resourceUniverse/virtualFs/lazyVscodeArchiveResources";
import { affectsResourceResolutionConfiguration } from "../utils/resourceConfigurationKeys";
import { ResourceUniverseNavigationFacade } from "../services/resourceUniverseNavigationFacade";

export interface ResourceInfrastructure extends vscode.Disposable {
  readonly projects: ResourcePackProjectService;
  readonly universe: ResourceUniverseService;
  readonly navigation: ResourceUniverseNavigationFacade;
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
  const navigation = new ResourceUniverseNavigationFacade(projects, universe);
  const archiveResources = new LazyVscodeArchiveResources(
    vscode,
    uri => navigation.invalidateUri(uri)
  );
  const physicalProvider = universe.registerProvider(new PhysicalAssetContributionProvider(
    new VscodePhysicalAssetSource(projects, archiveResources)
  ));
  const disposables: vscode.Disposable[] = [
    physicalProvider,
    archiveResources
  ];

  const metadataWatcher = vscode.workspace.createFileSystemWatcher(
    "**/{rsgl.config.json,pack.mcmeta}"
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
