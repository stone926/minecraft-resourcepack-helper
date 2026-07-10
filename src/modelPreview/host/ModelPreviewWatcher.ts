import * as vscode from "vscode";
import { isCitPropertiesFileName } from "../../cit/citPaths";
import { affectsResourceResolutionConfiguration } from "../../utils/resourceConfigurationKeys";
import { ModelDependencyTracker } from "../service/ModelDependencyTracker";
import { isModelPreviewFileName } from "./modelPreviewFiles";

export class ModelPreviewWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly tracker: ModelDependencyTracker,
    private readonly refresh: (changedFileNameOrUri?: string) => void,
    private readonly updateTargetFromActiveEditor: (uri: vscode.Uri) => void
  ) {
    this.watchWorkspaceFiles("**/assets/*/models/**/*.json");
    this.watchWorkspaceFiles("**/assets/*/citresewn/**/*.json");
    this.watchWorkspaceFiles("**/assets/*/textures/**/*.png");
    this.watchWorkspaceFiles("**/assets/*/citresewn/**/*.png");
    this.watchWorkspaceFiles("**/assets/*/textures/**/*.png.mcmeta");
    this.watchWorkspaceFiles("**/assets/*/citresewn/**/*.properties");

    this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.scheme !== "file" || !isModelPreviewFileName(event.document.fileName)) {
        return;
      }

      if (!this.tracker.hasFile(event.document.fileName)) {
        return;
      }

      if (!isCitPropertiesFileName(event.document.fileName) && !isJsonComplete(event.document.getText())) {
        return;
      }

      this.refreshSoon(event.document.fileName);
    }));

    this.disposables.push(vscode.workspace.onDidSaveTextDocument(document => {
      if (document.uri.scheme === "file" && this.tracker.hasFile(document.fileName)) {
        this.refreshSoon(document.fileName);
      }
    }));

    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor?.document.uri.scheme === "file" && isModelPreviewFileName(editor.document.fileName)) {
        this.updateTargetFromActiveEditor(editor.document.uri);
      }
    }));

    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (affectsResourceResolutionConfiguration(event)) {
        this.refreshSoon("configuration");
      }
    }));
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.disposables.forEach(disposable => disposable.dispose());
  }

  private watchWorkspaceFiles(pattern: string): void {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.disposables.push(watcher);
    watcher.onDidCreate(uri => this.refreshIfDependency(uri), null, this.disposables);
    watcher.onDidChange(uri => this.refreshIfDependency(uri), null, this.disposables);
    watcher.onDidDelete(uri => this.refreshIfDependency(uri), null, this.disposables);
  }

  private refreshIfDependency(uri: vscode.Uri): void {
    if (uri.scheme === "file" && this.tracker.hasFile(uri.fsPath)) {
      this.refreshSoon(uri.fsPath);
    }
  }

  private refreshSoon(_reason: string): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh(_reason);
    }, 180);
  }
}

function isJsonComplete(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
