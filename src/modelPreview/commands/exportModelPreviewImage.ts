import * as vscode from "vscode";
import { ModelPreviewPanel } from "../host/ModelPreviewPanel";
import type { ScreenshotOptions } from "../host/ModelPreviewMessages";
import type { ModelPreviewService } from "../service/ModelPreviewService";
import { resolveModelPreviewTarget } from "./openModelPreview";

export function exportModelPreviewImageCommand(extensionUri: vscode.Uri, service: ModelPreviewService) {
  return async (uri?: vscode.Uri): Promise<vscode.Uri | null> => {
    const panel = await getOrOpenPanel(extensionUri, service, uri);
    if (!panel) {
      return null;
    }

    return panel.exportImage();
  };
}

export function captureModelPreviewImageCommand(extensionUri: vscode.Uri, service: ModelPreviewService) {
  return async (uri?: vscode.Uri, options: ScreenshotOptions = {}): Promise<string | null> => {
    const panel = await getOrOpenPanel(extensionUri, service, uri);
    if (!panel) {
      return null;
    }

    return panel.captureImage(options);
  };
}

async function getOrOpenPanel(
  extensionUri: vscode.Uri,
  service: ModelPreviewService,
  uri?: vscode.Uri
): Promise<ModelPreviewPanel | null> {
  if (!uri && ModelPreviewPanel.currentPanel()) {
    return ModelPreviewPanel.currentPanel();
  }

  const target = resolveModelPreviewTarget(uri);
  return target ? ModelPreviewPanel.open(extensionUri, service, target) : null;
}
