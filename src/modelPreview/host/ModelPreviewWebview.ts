import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { ModelPreviewDocument, PreviewMaterial } from "../ir/PreviewDocument";

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

    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; connect-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${stylesUri}">
  <title>Model Preview</title>
</head>
<body>
  <div id="app">
    <header class="toolbar" role="toolbar">
      <button id="resetView" title="Reset view">Reset</button>
      <select id="viewPreset" title="View preset">
        <option value="default">3/4</option>
        <option value="front">Front</option>
        <option value="back">Back</option>
        <option value="left">Left</option>
        <option value="right">Right</option>
        <option value="top">Top</option>
        <option value="bottom">Bottom</option>
      </select>
      <button id="cameraMode" title="Perspective / orthographic">Persp</button>
      <select id="displayMode" title="Display mode">
        <option value="textured">Texture</option>
        <option value="solid">Solid</option>
        <option value="wireframe">Wire</option>
      </select>
      <label><input id="showGrid" type="checkbox" checked> Grid</label>
      <label><input id="showAxes" type="checkbox" checked> Axes</label>
      <button id="exportImage" title="Export PNG">Export</button>
    </header>
    <main id="previewLayout" class="preview-layout">
      <section class="viewport">
        <canvas id="previewCanvas"></canvas>
      </section>
      <div id="detailsResizer" class="details-resizer" role="separator" aria-label="Resize details panel" aria-controls="detailsPanel" aria-orientation="vertical" tabindex="0"></div>
      <aside id="detailsPanel" class="details">
        <section class="details-section" data-details-section>
          <h2>
            <button class="details-toggle" type="button" data-details-toggle aria-expanded="true" aria-controls="issuesBody">
              <span class="details-caret" aria-hidden="true"></span>
              <span>Issues</span>
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
              <span>Dependencies</span>
            </button>
          </h2>
          <div id="dependenciesBody" class="details-body">
            <ul id="dependencies"></ul>
          </div>
        </section>
      </aside>
    </main>
  </div>
  <script type="module" nonce="${nonce}" src="${mainScriptUri}"></script>
</body>
</html>`;
  }

  toWebviewDocument(document: ModelPreviewDocument): ModelPreviewDocument {
    return {
      ...document,
      materials: document.materials.map(material => this.toWebviewMaterial(material))
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

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
