import * as vscode from "vscode";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import { getResourceConfiguration } from "../../utils/resourceConfiguration";
import { getResourceGraphNodeUri } from "../../views/resourceGraphTreeItem";
import { createModelPreviewHostFileSystem } from "../host/createModelPreviewHostFileSystem";
import type { ScreenshotOptions } from "../host/ModelPreviewMessages";
import { createWorkspaceCacheModelLoader, resolveWorkspaceResourcePath } from "../host/workspaceCacheModelBackend";
import { ModelPreviewService } from "../service/ModelPreviewService";
import {
  captureModelPreviewImageCommand,
  exportModelPreviewImageCommand
} from "./exportModelPreviewImage";
import { openModelPreviewCommand } from "./openModelPreview";

export interface ModelPreviewCommandRuntime {
  open(uri?: vscode.Uri): Promise<unknown>;
  openGraphNode(node?: unknown): Promise<unknown>;
  exportImage(uri?: vscode.Uri): Promise<vscode.Uri | null>;
  captureImage(uri?: vscode.Uri, options?: ScreenshotOptions): Promise<string | null>;
}

export function createModelPreviewCommandRuntime(extensionUri: vscode.Uri): ModelPreviewCommandRuntime {
  const fileSystem = createModelPreviewHostFileSystem();
  const service = new ModelPreviewService({
    fileSystem,
    configuration: getResourceConfiguration,
    artifactCache: workspaceResourceCache.modelPreviewArtifacts,
    modelLoader: createWorkspaceCacheModelLoader(fileSystem),
    resolveResourcePath: resolveWorkspaceResourcePath
  });
  const open = openModelPreviewCommand(extensionUri, service);
  const exportImage = exportModelPreviewImageCommand(extensionUri, service);
  const captureImage = captureModelPreviewImageCommand(extensionUri, service);

  return {
    open,
    openGraphNode: node => {
      const uri = getResourceGraphNodeUri(node);
      return open(uri ?? undefined);
    },
    exportImage,
    captureImage
  };
}
