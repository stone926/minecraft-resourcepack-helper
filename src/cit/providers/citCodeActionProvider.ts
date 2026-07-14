import * as path from "node:path";
import * as vscode from "vscode";
import { packRootFromAssetsPath } from "../../../packages/mc-assets/src";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import { citResourceTypeFor } from "../citAssetResolver";
import type { CitResourceType } from "../citKeyResolution";
import { getCitPathCandidates } from "../citPaths";
import { generateReferenceRedirectPath } from "../../utils/pathGenerator";
import { getResourceReferences, type ResourceReference } from "../../utils/resourceReferences";

export const createMissingCitResourceCommand = "McResHelper.createMissingCitResource";

const missingPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lLD9WQAAAABJRU5ErkJggg==",
  "base64"
);

const citCodeActionProvider: vscode.CodeActionProvider = {
  provideCodeActions(document: vscode.TextDocument, range: vscode.Range) {
    const actions: vscode.CodeAction[] = [];
    const references = getResourceReferences(document);

    references.forEach((reference, index) => {
      if (reference.resolveMode !== "cit" || reference.value.startsWith("#")) {
        return;
      }
      if (!reference.synthetic && !referenceRangeIntersects(reference, range)) {
        return;
      }
      if (generateReferenceRedirectPath(reference, document)) {
        return;
      }

      const target = getCreateTargetPath(document.fileName, reference);
      if (!target) {
        return;
      }

      const action = new vscode.CodeAction(vscode.l10n.t("Create missing CIT resource"), vscode.CodeActionKind.QuickFix);
      action.command = {
        command: createMissingCitResourceCommand,
        title: vscode.l10n.t("Create missing CIT resource"),
        arguments: [document.uri, index]
      };
      action.diagnostics = [];
      action.isPreferred = true;
      actions.push(action);
    });

    return actions;
  }
};

export default citCodeActionProvider;

export async function createMissingCitResource(uri: vscode.Uri, referenceIndex: number): Promise<vscode.Uri | null> {
  const document = await vscode.workspace.openTextDocument(uri);
  const reference = getResourceReferences(document)[referenceIndex];
  if (!reference) {
    return null;
  }

  const targetPath = getCreateTargetPath(document.fileName, reference);
  if (!targetPath) {
    return null;
  }

  const target = vscode.Uri.file(targetPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
  await vscode.workspace.fs.writeFile(target, getDefaultContent(reference));
  const targetDocument = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(targetDocument);
  return target;
}

function getCreateTargetPath(documentFileName: string, reference: ResourceReference): string | null {
  const resourceType = getResourceType(reference);
  if (!resourceType) {
    return null;
  }

  const packRoot = workspaceResourceCache.getPackRoot(documentFileName) ?? packRootFromAssetsPath(documentFileName);
  if (!packRoot) {
    return null;
  }

  return getCitPathCandidates(documentFileName, packRoot, reference.value, resourceType)[0] ?? null;
}

function getResourceType(reference: ResourceReference): CitResourceType | null {
  if (reference.origin === "citAutoDiscovery") {
    return "models";
  }
  return citResourceTypeFor(reference.target, reference.extension);
}

function getDefaultContent(reference: ResourceReference): Uint8Array {
  if (getResourceType(reference) === "textures") {
    return missingPng;
  }

  const json = {
    parent: "minecraft:item/generated",
    textures: {
      layer0: "minecraft:item/generated"
    }
  };
  return Buffer.from(`${JSON.stringify(json, null, 2)}\n`, "utf8");
}

function referenceRangeIntersects(reference: ResourceReference, range: vscode.Range): boolean {
  const loc = reference.valueNode.valueLoc ?? reference.valueNode.loc;
  if (!loc) {
    return false;
  }

  return new vscode.Range(
    new vscode.Position(loc.start.line - 1, loc.start.column),
    new vscode.Position(loc.end.line - 1, loc.end.column)
  ).intersection(range) !== undefined;
}
