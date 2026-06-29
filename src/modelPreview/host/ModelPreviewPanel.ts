import * as path from "node:path";
import * as vscode from "vscode";
import { ModelPreviewService } from "../service/ModelPreviewService";
import { ModelDependencyTracker } from "../service/ModelDependencyTracker";
import type { WebviewToHost, ScreenshotOptions } from "./ModelPreviewMessages";
import { getModelPreviewLocalResourceRoots, ModelPreviewWebview } from "./ModelPreviewWebview";
import { ModelPreviewWatcher } from "./ModelPreviewWatcher";
import { isModelPreviewFileName } from "./modelPreviewFiles";

interface PendingScreenshot {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ModelPreviewPanel implements vscode.Disposable {
  private static current: ModelPreviewPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly webview: ModelPreviewWebview;
  private readonly tracker = new ModelDependencyTracker();
  private readonly watcher: ModelPreviewWatcher;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingScreenshots = new Map<string, PendingScreenshot>();
  private targetUri: vscode.Uri;
  private ready = false;
  private disposed = false;

  static open(extensionUri: vscode.Uri, service: ModelPreviewService, targetUri: vscode.Uri): ModelPreviewPanel {
    if (ModelPreviewPanel.current) {
      ModelPreviewPanel.current.setTarget(targetUri);
      ModelPreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return ModelPreviewPanel.current;
    }

    const panel = new ModelPreviewPanel(extensionUri, service, targetUri);
    ModelPreviewPanel.current = panel;
    return panel;
  }

  static currentPanel(): ModelPreviewPanel | null {
    return ModelPreviewPanel.current;
  }

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: ModelPreviewService,
    targetUri: vscode.Uri
  ) {
    this.targetUri = targetUri;
    this.panel = vscode.window.createWebviewPanel(
      "McResHelper.modelPreview",
      vscode.l10n.t("Model Preview"),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: getModelPreviewLocalResourceRoots(extensionUri, targetUri.fsPath)
      }
    );
    this.webview = new ModelPreviewWebview(extensionUri, this.panel);
    this.webview.setHtml();

    this.watcher = new ModelPreviewWatcher(
      this.tracker,
      changedFileNameOrUri => this.refresh(changedFileNameOrUri),
      uri => this.setTarget(uri)
    );
    this.disposables.push(this.watcher);

    this.disposables.push(this.panel.onDidDispose(() => this.dispose()));
    this.disposables.push(this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message as WebviewToHost)));
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    if (ModelPreviewPanel.current === this) {
      ModelPreviewPanel.current = null;
    }

    for (const pending of this.pendingScreenshots.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Model preview panel was closed"));
    }
    this.pendingScreenshots.clear();
    this.disposables.forEach(disposable => disposable.dispose());
  }

  async captureImage(options: ScreenshotOptions = {}): Promise<string> {
    if (!this.ready) {
      await this.waitUntilReady();
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingScreenshots.delete(requestId);
        reject(new Error("Model preview screenshot timed out"));
      }, 10000);
      this.pendingScreenshots.set(requestId, { resolve, reject, timer });
    });

    await this.panel.webview.postMessage({ type: "requestScreenshot", requestId, options });
    return result;
  }

  async exportImage(): Promise<vscode.Uri | null> {
    const dataUri = await this.captureImage();
    const target = await vscode.window.showSaveDialog({
      title: vscode.l10n.t("Save Model Preview Image"),
      filters: {
        [vscode.l10n.t("PNG image")]: ["png"]
      },
      defaultUri: vscode.Uri.file(defaultScreenshotFileName(this.targetUri.fsPath))
    });

    if (!target) {
      return null;
    }

    await vscode.workspace.fs.writeFile(target, decodePngDataUri(dataUri));
    return target;
  }

  private setTarget(uri: vscode.Uri): void {
    if (uri.scheme !== "file" || !isModelPreviewFileName(uri.fsPath)) {
      return;
    }

    if (this.targetUri.toString() === uri.toString()) {
      return;
    }

    this.targetUri = uri;
    this.panel.webview.options = {
      ...this.panel.webview.options,
      localResourceRoots: getModelPreviewLocalResourceRoots(this.extensionUri, uri.fsPath)
    };
    this.refresh(uri.fsPath);
  }

  private async refresh(changedFileNameOrUri?: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (changedFileNameOrUri === "configuration") {
      this.service.invalidateAll();
    } else if (changedFileNameOrUri) {
      this.service.invalidateDependents(changedFileNameOrUri);
    } else {
      this.service.invalidate(this.targetUri.fsPath);
    }

    const document = await this.service.getPreviewDocument(this.targetUri.fsPath);
    this.tracker.update(document);
    this.panel.title = `${vscode.l10n.t("Model Preview")}: ${path.basename(this.targetUri.fsPath)}`;
    await this.panel.webview.postMessage({
      type: "updatePreview",
      document: this.webview.toWebviewDocument(document)
    });
  }

  private handleMessage(message: WebviewToHost): void {
    if (message.type === "ready") {
      this.ready = true;
      void this.refresh();
      return;
    }

    if (message.type === "exportImage") {
      void this.exportImage().catch(error => {
        void vscode.window.showErrorMessage(vscode.l10n.t("Model preview export failed: {0}", String(error)));
      });
      return;
    }

    if (message.type === "renderIssue") {
      void vscode.window.showWarningMessage(message.message);
      return;
    }

    const pending = this.pendingScreenshots.get(message.requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingScreenshots.delete(message.requestId);
    pending.resolve(message.pngDataUri);
  }

  private waitUntilReady(): Promise<void> {
    return new Promise(resolve => {
      const disposable = this.panel.webview.onDidReceiveMessage(message => {
        if ((message as WebviewToHost).type === "ready") {
          disposable.dispose();
          resolve();
        }
      });
      this.disposables.push(disposable);
    });
  }
}

function defaultScreenshotFileName(modelFileName: string): string {
  const parsed = path.parse(modelFileName);
  return path.join(parsed.dir, `${parsed.name}.preview.png`);
}

function decodePngDataUri(dataUri: string): Uint8Array {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUri);
  if (!match) {
    throw new Error("Invalid PNG data URI");
  }

  return Buffer.from(match[1], "base64");
}
