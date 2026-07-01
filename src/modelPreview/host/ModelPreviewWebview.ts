import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { modelPreviewWebviewMessages } from "../../i18n/messages";
import { localize } from "../../i18n/runtime";
import type { ModelPreviewDocument, PreviewMaterial, WebviewModelPreviewDocument } from "../ir/PreviewDocument";

export class ModelPreviewWebview {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel
  ) { }

  setHtml(): void {
    const webview = this.panel.webview;
    const nonce = createNonce();
    const mainScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "webviews", "modelPreview", "main.js"));
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "webviews", "modelPreview", "styles.css"));
    const l10n = createWebviewL10nDictionary();
    const text = (key: string) => escapeHtml(l10n[key] ?? key);
    const attr = (key: string) => escapeAttribute(l10n[key] ?? key);

    webview.html = `<!DOCTYPE html>
<html lang="${escapeAttribute(vscode.env.language)}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; connect-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${stylesUri}">
  <title>${text("Model Preview")}</title>
</head>
<body>
  <div id="app">
    <header class="toolbar" role="toolbar">
      <button id="resetView" title="${attr("Reset view")}">${text("Reset")}</button>
      <button id="refreshPreview" title="${attr("Refresh preview")}">${text("Refresh")}</button>
      <select id="viewPreset" title="${attr("View preset")}">
        <option value="default">${text("3/4")}</option>
        <option value="front">${text("Front")}</option>
        <option value="back">${text("Back")}</option>
        <option value="left">${text("Left")}</option>
        <option value="right">${text("Right")}</option>
        <option value="top">${text("Top")}</option>
        <option value="bottom">${text("Bottom")}</option>
      </select>
      <button id="cameraMode" title="${attr("Perspective / orthographic")}">${text("Persp")}</button>
      <select id="displayMode" title="${attr("Display mode")}">
        <option value="textured">${text("Texture")}</option>
        <option value="solid">${text("Solid")}</option>
        <option value="wireframe">${text("Wire")}</option>
      </select>
      <label><input id="showGrid" type="checkbox" checked> ${text("Grid")}</label>
      <label><input id="showAxes" type="checkbox" checked> ${text("Axes")}</label>
      <button id="exportImage" title="${attr("Export PNG")}">${text("Export")}</button>
    </header>
    <main id="previewLayout" class="preview-layout">
      <section class="viewport">
        <canvas id="previewCanvas"></canvas>
      </section>
      <div id="detailsResizer" class="details-resizer" role="separator" aria-label="${attr("Resize details panel")}" aria-controls="detailsPanel" aria-orientation="vertical" tabindex="0"></div>
      <aside id="detailsPanel" class="details">
        <section class="details-section" data-details-section>
          <h2>
            <button class="details-toggle" type="button" data-details-toggle aria-expanded="true" aria-controls="issuesBody">
              <span class="details-caret" aria-hidden="true"></span>
              <span>${text("Issues")}</span>
            </button>
          </h2>
          <div id="issuesBody" class="details-body">
            <ul id="issues"></ul>
          </div>
        </section>
        <section class="details-section" data-details-section>
          <h2>
            <button class="details-toggle" type="button" data-details-toggle aria-expanded="true" aria-controls="dependenciesBody">
              <span class="details-caret" aria-hidden="true"></span>
              <span>${text("Dependencies")}</span>
            </button>
          </h2>
          <div id="dependenciesBody" class="details-body">
            <ul id="dependencies"></ul>
          </div>
        </section>
      </aside>
    </main>
    <dialog id="exportDialog" class="export-dialog">
      <form id="exportForm" method="dialog">
        <div class="export-grid">
          <label for="exportWidth">${text("Width")}</label>
          <input id="exportWidth" type="number" min="1" max="8192" step="1">
          <label for="exportHeight">${text("Height")}</label>
          <input id="exportHeight" type="number" min="1" max="8192" step="1">
          <label for="exportTransparent">${text("Transparent")}</label>
          <input id="exportTransparent" type="checkbox">
          <label for="exportBackground">${text("Background")}</label>
          <input id="exportBackground" type="color" value="#1e1e1e">
        </div>
        <p id="exportError" class="export-error" role="alert"></p>
        <div class="export-actions">
          <button id="exportCancel" value="cancel" type="button">${text("Cancel")}</button>
          <button id="exportConfirm" value="default" type="submit">${text("Export")}</button>
        </div>
      </form>
    </dialog>
  </div>
  <script nonce="${nonce}">
    globalThis.__MC_RES_HELPER_L10N__ = ${escapeScriptJson(l10n)};
  </script>
  <script type="module" nonce="${nonce}" src="${mainScriptUri}"></script>
</body>
</html>`;
  }

  toWebviewDocument(document: ModelPreviewDocument): WebviewModelPreviewDocument {
    return {
      ...document,
      materials: document.materials.map(material => this.toWebviewMaterial(material)),
      issues: document.issues.map(issue => ({
        ...issue,
        message: localize(issue.message)
      }))
    };
  }

  private toWebviewMaterial(material: PreviewMaterial): PreviewMaterial {
    if (!material.textureUri) {
      return material;
    }

    const uri = vscode.Uri.parse(material.textureUri);
    if (uri.scheme !== "file") {
      return material;
    }

    return {
      ...material,
      textureUri: this.panel.webview.asWebviewUri(uri).toString()
    };
  }
}

function createWebviewL10nDictionary(): Record<string, string> {
  return Object.fromEntries(modelPreviewWebviewMessages.map(message => [message.message, localize(message)]));
}

export function getModelPreviewLocalResourceRoots(extensionUri: vscode.Uri, modelFileName?: string): vscode.Uri[] {
  const roots: vscode.Uri[] = [extensionUri];

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    roots.push(folder.uri);
  }

  const configuration = vscode.workspace.getConfiguration();
  const defaultAssetsPath = configuration.get<string | null>("McResHelper.defaultMcAssetsPath");
  if (defaultAssetsPath) {
    roots.push(vscode.Uri.file(defaultAssetsPath));
  }

  for (const root of configuration.get<string[]>("McResHelper.resourcePackLoadOrder") ?? []) {
    if (root.trim()) {
      roots.push(vscode.Uri.file(root));
    }
  }

  if (modelFileName) {
    const packRoot = findPackRoot(modelFileName);
    roots.push(vscode.Uri.file(packRoot ?? path.dirname(modelFileName)));
  }

  return uniqueRoots(roots);
}

function findPackRoot(fileName: string): string | null {
  let current = path.dirname(path.normalize(fileName));
  const root = path.parse(current).root;

  while (current !== root) {
    if (fs.existsSync(path.join(current, "pack.mcmeta"))) {
      return current;
    }
    current = path.dirname(current);
  }

  return null;
}

function uniqueRoots(roots: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  return roots.filter(root => {
    const key = root.toString().toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
