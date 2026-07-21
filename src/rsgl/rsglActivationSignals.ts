import * as vscode from "vscode";

export type ConfiguredRsglMode = "auto" | "on" | "off";

export const rsglEnablementConfiguration = "McResHelper.rsgl.enabled";

export const rsglProxyCommands = {
  build: "rsgl.build",
  previewBuild: "rsgl.previewBuild",
  buildDirectory: "rsgl.buildDirectory",
  previewDirectoryBuild: "rsgl.previewDirectoryBuild",
  buildWorkspace: "rsgl.buildWorkspace",
  previewWorkspaceBuild: "rsgl.previewWorkspaceBuild",
  refreshWorkspace: "rsgl.refreshWorkspace"
} as const;

export function configuredRsglMode(): ConfiguredRsglMode {
  const configured = vscode.workspace.getConfiguration("McResHelper").get<string>("rsgl.enabled", "auto");
  return configured === "on" || configured === "off" ? configured : "auto";
}

export function isRsglDocument(
  document: Pick<vscode.TextDocument, "languageId" | "uri">
): boolean {
  return document.languageId === "rsgl" || document.uri.path.toLowerCase().endsWith(".rsgl");
}

export async function showRsglDisabledMessage(): Promise<void> {
  await vscode.window.showInformationMessage(vscode.l10n.t("RSGL language services are disabled by McResHelper.rsgl.enabled."
  ));
}
