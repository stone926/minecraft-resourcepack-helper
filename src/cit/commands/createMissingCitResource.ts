import * as vscode from "vscode";
import { internalCommands } from "../../commandIds";
import { getResourceReferences } from "../../utils/resourceReferences";
import { MissingCitResourceApplicationService } from "../services/missingCitResourceApplicationService";
import { MissingCitResourcePlanner } from "../services/missingCitResourcePlanner";

export const createMissingCitResourceCommand = internalCommands.createMissingCitResource;

const missingResourcePlanner = new MissingCitResourcePlanner();
const missingResourceApplication = new MissingCitResourceApplicationService();

export async function createMissingCitResource(
  uri: vscode.Uri,
  referenceIndex: number
): Promise<vscode.Uri | null> {
  const document = await vscode.workspace.openTextDocument(uri);
  const reference = getResourceReferences(document)[referenceIndex];
  if (!reference) {
    return null;
  }

  const plan = missingResourcePlanner.plan(document.fileName, reference);
  return plan ? missingResourceApplication.create(plan) : null;
}
