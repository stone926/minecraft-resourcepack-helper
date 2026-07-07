import * as path from "node:path";
import * as vscode from "vscode";
import { generateCitForResource } from "./citTemplate";

export default async function generateCitForCurrentItemCommand(): Promise<vscode.Uri | null> {
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (!activeDocument || activeDocument.uri.scheme !== "file") {
    void vscode.window.showErrorMessage(vscode.l10n.t("No item resource editor is active"));
    return null;
  }

  const generated = generateCitForResource(activeDocument.fileName);
  if (!generated) {
    void vscode.window.showErrorMessage(vscode.l10n.t("Current resource cannot be converted to a CIT"));
    return null;
  }

  const target = await vscode.window.showSaveDialog({
    title: vscode.l10n.t("Generate CIT for current item"),
    defaultUri: vscode.Uri.file(generated.fileName),
    filters: {
      [vscode.l10n.t("CIT properties")]: ["properties"]
    }
  });
  if (!target) {
    return null;
  }

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
  await vscode.workspace.fs.writeFile(target, Buffer.from(generated.text, "utf8"));
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document);
  return target;
}
