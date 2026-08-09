import { jsonAstLocationToLineCharacterRange } from "../../utils/astLocationRanges";
import { internalCommands } from "../../commandIds";
import * as vscode from "vscode";
import { generateReferenceRedirectPath } from "../../utils/pathGenerator";
import { toVscodeRange } from "../../utils/resourceLocationVscode";
import { getResourceReferences, type ResourceReference } from "../../utils/resourceReferences";
import { MissingCitResourcePlanner } from "../services/missingCitResourcePlanner";

const missingResourcePlanner = new MissingCitResourcePlanner();

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
        command: internalCommands.createMissingCitResource,
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

function referenceRangeIntersects(reference: ResourceReference, range: vscode.Range): boolean {
  const loc = reference.valueNode.valueLoc ?? reference.valueNode.loc;
  if (!loc) {
    return false;
  }

  return rangeFromJsonAstLocation(loc).intersection(range) !== undefined;
}

function rangeFromJsonAstLocation(loc: { start: { line: number; column: number }; end: { line: number; column: number } }): vscode.Range {
  return toVscodeRange(jsonAstLocationToLineCharacterRange(loc));
}
