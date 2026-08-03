import * as vscode from "vscode";
import { isCitPropertiesFileName } from "../../cit/citPaths";
import { affectsResourceResolutionConfiguration } from "../../utils/resourceConfigurationKeys";
import { ModelDependencyTracker } from "../service/ModelDependencyTracker";
import { isModelPreviewFileName, isPackMetadataFileName } from "./modelPreviewFiles";
import { getModelPreviewWatcherPatterns } from "./modelPreviewWatchTargets";
import { ModelPreviewRefreshScheduler } from "./ModelPreviewRefreshScheduler";

export class ModelPreviewWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly refreshScheduler: ModelPreviewRefreshScheduler;

  constructor(
    private readonly tracker: ModelDependencyTracker,
    private readonly refresh: (changedFileNameOrUri?: string) => void,
    private readonly updateTargetFromActiveEditor: (uri: vscode.Uri) => void
  ) {
    this.refreshScheduler = new ModelPreviewRefreshScheduler(reason => this.refresh(reason));
    for (const pattern of getModelPreviewWatcherPatterns()) {
      this.watchWorkspaceFiles(pattern);
    }

    this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.scheme !== "file" || (
        !isModelPreviewFileName(event.document.fileName) &&
        !isPackMetadataFileName(event.document.fileName)
      )) {
        return;
      }

      if (!this.tracker.hasFile(event.document.fileName)) {
        return;
      }

      this.refreshSoon(
        event.document.fileName,
        () => !event.document.isClosed && (
          isCitPropertiesFileName(event.document.fileName) || isJsonComplete(event.document.getText())
        )
      );
    }));

    this.disposables.push(vscode.workspace.onDidSaveTextDocument(document => {
      if (document.uri.scheme === "file" && this.tracker.hasFile(document.fileName)) {
        this.refreshSoon(document.fileName);
      }
    }));

    this.disposables.push(
      vscode.workspace.onDidCreateFiles(event => this.refreshIfDependencyStructure(event.files)),
      vscode.workspace.onDidDeleteFiles(event => this.refreshIfDependencyStructure(event.files)),
      vscode.workspace.onDidRenameFiles(event => this.refreshIfDependencyStructure(
        event.files.flatMap(file => [file.oldUri, file.newUri])
      ))
    );

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
    this.refreshScheduler.dispose();
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

  private refreshSoon(reason: string, shouldRefresh?: () => boolean): void {
    this.refreshScheduler.schedule(reason, shouldRefresh);
  }

  private refreshIfDependencyStructure(uris: readonly vscode.Uri[]): void {
    const changed = uris.find(uri =>
      uri.scheme === "file" && this.tracker.hasFileAtOrBelow(uri.fsPath)
    );
    if (changed) {
      this.refreshSoon(changed.fsPath);
    }
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
