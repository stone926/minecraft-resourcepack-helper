import * as vscode from "vscode";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import { getResourceConfiguration } from "../../utils/resourceConfiguration";
import { getResourceGraphNodeUri } from "../../views/resourceGraphTreeItem";
import { ModelPreviewHostFileSystem } from "../host/ModelPreviewHostFileSystem";
import type { ScreenshotOptions } from "../host/ModelPreviewMessages";
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
  const service = new ModelPreviewService({
    fileSystem: new ModelPreviewHostFileSystem(),
    configuration: getResourceConfiguration,
    artifactCache: workspaceResourceCache.modelPreviewArtifacts
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
