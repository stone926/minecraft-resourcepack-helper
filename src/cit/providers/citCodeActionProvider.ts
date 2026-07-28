import { internalCommands } from "../../commandIds";
import * as vscode from "vscode";
import { generateReferenceRedirectPath } from "../../utils/pathGenerator";
import { getResourceReferences, type ResourceReference } from "../../utils/resourceReferences";
import { MissingCitResourceApplicationService } from "../services/missingCitResourceApplicationService";
import { MissingCitResourcePlanner } from "../services/missingCitResourcePlanner";

export const createMissingCitResourceCommand = internalCommands.createMissingCitResource;

const missingResourcePlanner = new MissingCitResourcePlanner();
const missingResourceApplication = new MissingCitResourceApplicationService();

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

      const target = missingResourcePlanner.targetPath(document.fileName, reference);
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

  const plan = missingResourcePlanner.plan(document.fileName, reference);
  if (!plan) {
    return null;
  }
  return missingResourceApplication.create(plan);
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
