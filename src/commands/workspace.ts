import * as vscode from "vscode";

export async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage(vscode.l10n.t("McResHelper: No open folder, failed to create resource pack"));
    return null;
  }

  if (folders.length === 1) {
    return folders[0];
  }

  const selected = await vscode.window.showQuickPick(
    folders.map(folder => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder
    })),
    {
      placeHolder: vscode.l10n.t("Select workspace folder")
    }
  );

  return selected?.folder ?? null;
}
