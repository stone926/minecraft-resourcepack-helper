import * as vscode from "vscode";
import { isLanguageDocumentLike } from "../../packages/shared-utils/src";

export type ConfiguredRsglMode = "auto" | "on" | "off";

export const rsglEnablementConfiguration = "McResHelper.rsgl.enabled";
const enablementSection = rsglEnablementConfiguration.slice(0, rsglEnablementConfiguration.indexOf("."));
const enablementSetting = rsglEnablementConfiguration.slice(rsglEnablementConfiguration.indexOf(".") + 1);

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
  const configured = vscode.workspace.getConfiguration(enablementSection).get<string>(enablementSetting, "auto");
  return configured === "on" || configured === "off" ? configured : "auto";
}

/**
 * Root-bundle `.rsgl` document predicate. Lazily loaded RSGL surfaces use
 * `isRsglDocumentLike` from rsgl-shared instead; the build contract keeps
 * this bundle physically unreachable from that package.
 */
export function isRsglDocument(
  document: Pick<vscode.TextDocument, "languageId" | "uri"> & { fileName?: string }
): boolean {
  return isLanguageDocumentLike({
    languageId: document.languageId,
    fileName: document.fileName,
    uriPath: document.uri.path
  }, "rsgl", ".rsgl");
}

export async function showRsglDisabledMessage(): Promise<void> {
  await vscode.window.showInformationMessage(vscode.l10n.t("RSGL language services are disabled by McResHelper.rsgl.enabled."
  ));
}

export interface RsglDisabledDocumentNotifier {
  notify(document: Pick<vscode.TextDocument, "uri">): Promise<boolean>;
}

/** Deduplicates disabled-service notices by document identity for one owner. */
export function createRsglDisabledDocumentNotifier(
  showMessage: () => Promise<void> = showRsglDisabledMessage
): RsglDisabledDocumentNotifier {
  const notifiedDocuments = new Set<string>();
  return {
    notify: async document => {
      const identity = document.uri.toString();
      if (notifiedDocuments.has(identity)) {
        return false;
      }
      notifiedDocuments.add(identity);
      await showMessage();
      return true;
    }
  };
}
