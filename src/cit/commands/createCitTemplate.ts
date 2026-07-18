import * as path from "node:path";
import * as vscode from "vscode";
import { createCitTemplate, type CitTemplateType } from "./citTemplate";

export default async function createCitTemplateCommand(): Promise<vscode.Uri | null> {
  const selectedType = await vscode.window.showQuickPick(
    getCitTemplateTypeItems(),
    { title: vscode.l10n.t("Select CIT type") }
  );
  if (!selectedType) {
    return null;
  }
  const type = selectedType.type;

  const defaultUri = getDefaultCitUri(type);
  const target = await vscode.window.showSaveDialog({
    title: vscode.l10n.t("Create CIT template"),
    defaultUri,
    filters: {
      [vscode.l10n.t("CIT properties")]: ["properties"]
    }
  });
  if (!target) {
    return null;
  }

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
  await vscode.workspace.fs.writeFile(target, Buffer.from(createCitTemplate(type), "utf8"));
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document);
  return target;
}

interface CitTemplateTypeQuickPickItem extends vscode.QuickPickItem {
  type: CitTemplateType;
}

function getCitTemplateTypeItems(): CitTemplateTypeQuickPickItem[] {
  return [
    { label: vscode.l10n.t("Item"), type: "item" },
    { label: vscode.l10n.t("Armor"), type: "armor" },
    { label: vscode.l10n.t("Elytra"), type: "elytra" },
    { label: vscode.l10n.t("Enchantment"), type: "enchantment" }
  ];
}

function getDefaultCitUri(type: CitTemplateType): vscode.Uri | undefined {
  const activeFileName = vscode.window.activeTextEditor?.document.uri.scheme === "file"
    ? vscode.window.activeTextEditor.document.fileName
    : undefined;
  if (!activeFileName) {
    return undefined;
  }

  const parsed = path.parse(activeFileName);
  return vscode.Uri.file(path.join(parsed.dir, `${type}.properties`));
}
