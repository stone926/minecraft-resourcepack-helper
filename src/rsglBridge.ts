import * as vscode from "vscode";
import { legacyRsglCommands, rsglApiVersion, rsglCommands, rsglExtensionId } from "../packages/rsgl-shared/src";

interface RsglApiCompatibility {
  apiVersion: number;
}

const legacyCommandMap = new Map<string, string>([
  [legacyRsglCommands.build, rsglCommands.build],
  [legacyRsglCommands.previewBuild, rsglCommands.previewBuild],
  [legacyRsglCommands.buildDirectory, rsglCommands.buildDirectory],
  [legacyRsglCommands.previewDirectoryBuild, rsglCommands.previewDirectoryBuild],
  [legacyRsglCommands.buildWorkspace, rsglCommands.buildWorkspace],
  [legacyRsglCommands.previewWorkspaceBuild, rsglCommands.previewWorkspaceBuild]
]);

export function registerRsglBridgeCommands(context: vscode.ExtensionContext): void {
  for (const [legacyCommand, rsglCommand] of legacyCommandMap) {
    context.subscriptions.push(vscode.commands.registerCommand(legacyCommand, async (...args: unknown[]) => {
      if (!(await ensureCompatibleRsglExtension())) {
        return;
      }
      await vscode.commands.executeCommand(rsglCommand, ...args);
    }));
  }
}

async function ensureCompatibleRsglExtension(): Promise<boolean> {
  const extension = vscode.extensions.getExtension<RsglApiCompatibility>(rsglExtensionId);
  if (!extension) {
    await vscode.window.showWarningMessage(vscode.l10n.t("RSGL support is not installed. Please install the RSGL extension."));
    return false;
  }

  const api = await extension.activate();
  if (!api || api.apiVersion !== rsglApiVersion) {
    await vscode.window.showWarningMessage(vscode.l10n.t("The installed RSGL extension is incompatible with this version of Minecraft Resourcepack Tools."));
    return false;
  }
  return true;
}
