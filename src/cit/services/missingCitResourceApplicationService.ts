import * as vscode from "vscode";
import type { MissingCitResourcePlan } from "./missingCitResourcePlanner";
import type { SafeCitResourceWriter } from "./safeCitResourceWriter";

/** Applies an already validated creation plan at the VS Code filesystem/UI boundary. */
export class MissingCitResourceApplicationService {
  public constructor(private readonly writer?: Pick<SafeCitResourceWriter, "create">) {}

  public async create(plan: MissingCitResourcePlan): Promise<vscode.Uri> {
    const target = vscode.Uri.file(plan.targetPath);
    const writer = this.writer ?? new (await import("./safeCitResourceWriter.js")).SafeCitResourceWriter();
    await writer.create(plan);
    const targetDocument = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(targetDocument);
    return target;
  }
}
