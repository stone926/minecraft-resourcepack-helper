import * as vscode from "vscode";
import { ModelPreviewPanel } from "../host/ModelPreviewPanel";
import { isModelPreviewFileName } from "../host/modelPreviewFiles";
import type { ModelPreviewService } from "../service/ModelPreviewService";

export function openModelPreviewCommand(extensionUri: vscode.Uri, service: ModelPreviewService) {
  return async (uri?: vscode.Uri): Promise<ModelPreviewPanel | null> => {
    const target = resolveModelPreviewTarget(uri);
    if (!target) {
      return null;
    }

    return ModelPreviewPanel.open(extensionUri, service, target);
  };
}

export function resolveModelPreviewTarget(uri?: vscode.Uri): vscode.Uri | null {
  const target = uri?.scheme === "file" ? uri : vscode.window.activeTextEditor?.document.uri;

  if (!target) {
    void vscode.window.showErrorMessage(vscode.l10n.t("No model JSON editor is active"));
    return null;
  }

  if (target.scheme !== "file" || !isModelPreviewFileName(target.fsPath)) {
    void vscode.window.showErrorMessage(vscode.l10n.t("Selected file is not a Minecraft model JSON"));
    return null;
  }

  return target;
}
