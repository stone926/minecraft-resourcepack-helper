import * as path from "node:path";
import * as vscode from "vscode";
import type { MissingCitResourcePlan } from "./missingCitResourcePlanner";

/** Applies an already validated creation plan at the VS Code filesystem/UI boundary. */
export class MissingCitResourceApplicationService {
  public async create(plan: MissingCitResourcePlan): Promise<vscode.Uri> {
    const target = vscode.Uri.file(plan.targetPath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
    await vscode.workspace.fs.writeFile(target, plan.content);
    const targetDocument = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(targetDocument);
    return target;
  }
}
