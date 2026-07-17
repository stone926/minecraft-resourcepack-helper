import { vscode, t } from "./webviewApi.js";
import { DetailsPanelController } from "./detailsPanel.js";
import { PreviewRenderer } from "./previewRenderer.js";

class PreviewApp {
  constructor() {
    this.disposables = [];
    this.disposed = false;
    this.detailsController = new DetailsPanelController(
      document.getElementById("previewLayout"),
      document.getElementById("detailsPanel"),
      document.getElementById("detailsResizer")
    );
    this.renderer = new PreviewRenderer(document.getElementById("previewCanvas"));
    this.issues = document.getElementById("issues");
    this.dependencies = document.getElementById("dependencies");
    this.exportDialog = document.getElementById("exportDialog");
    this.exportForm = document.getElementById("exportForm");
    this.exportWidth = document.getElementById("exportWidth");
    this.exportHeight = document.getElementById("exportHeight");
    this.exportTransparent = document.getElementById("exportTransparent");
    this.exportBackground = document.getElementById("exportBackground");
    this.exportError = document.getElementById("exportError");
    this.exportCancel = document.getElementById("exportCancel");

    this.addDomListener(document.getElementById("resetView"), "click", () => this.renderer.resetView());
    this.addDomListener(document.getElementById("refreshPreview"), "click", () => vscode.postMessage({ type: "refreshPreview" }));
    this.addDomListener(document.getElementById("viewPreset"), "change", event => this.renderer.setViewPreset(event.target.value));
    this.addDomListener(document.getElementById("cameraMode"), "click", event => {
      const mode = this.renderer.toggleCameraMode();
      event.currentTarget.textContent = mode === "perspective" ? t("Persp") : t("Ortho");
    });
    this.addDomListener(document.getElementById("displayMode"), "change", event => this.renderer.setDisplayMode(event.target.value));
    this.addDomListener(document.getElementById("showGrid"), "change", event => this.renderer.setGridVisible(event.target.checked));
    this.addDomListener(document.getElementById("showAxes"), "change", event => this.renderer.setAxesVisible(event.target.checked));
    this.addDomListener(document.getElementById("exportImage"), "click", () => this.openExportDialog());
    this.addDomListener(this.exportCancel, "click", () => this.exportDialog.close());
    this.addDomListener(this.exportForm, "submit", event => this.submitExport(event));
    this.addDomListener(this.exportTransparent, "change", () => this.updateExportBackgroundState());

    this.onWindowMessage = event => this.handleMessage(event.data);
    this.onBeforeUnload = () => this.dispose();
    window.addEventListener("message", this.onWindowMessage);
    window.addEventListener("beforeunload", this.onBeforeUnload);
    vscode.postMessage({ type: "ready" });
  }

  async handleMessage(message) {
    if (this.disposed || !message) {
      return;
    }

    if (message.type === "updatePreview") {
      this.renderer.setDocument(message.document);
      this.renderIssues(message.document.issues);
      this.renderDependencies(message.document.dependencies);
      return;
    }

    if (message.type === "requestScreenshot") {
      try {
        const pngDataUri = await this.renderer.capture(message.options ?? {});
        vscode.postMessage({ type: "screenshotResult", requestId: message.requestId, pngDataUri });
      } catch (error) {
        vscode.postMessage({
          type: "screenshotError",
          requestId: message.requestId,
          error: {
            code: "captureFailed",
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
      return;
    }

    if (message.type === "dispose") {
      this.dispose();
    }
  }

  addDomListener(target, type, listener) {
    target.addEventListener(type, listener);
    this.disposables.push(() => target.removeEventListener(type, listener));
  }

  openExportDialog() {
    const size = this.renderer.getCanvasSize();
    this.exportWidth.value = String(size.width);
    this.exportHeight.value = String(size.height);
    this.exportBackground.value = normalizeColorInput(this.renderer.getBackgroundColor());
    this.exportError.textContent = "";
    this.updateExportBackgroundState();
    this.exportDialog.showModal();
    this.exportWidth.select();
  }

  submitExport(event) {
    event.preventDefault();
    const options = this.readExportOptions();
    if (!options) {
      return;
    }

    this.exportDialog.close();
    vscode.postMessage({ type: "exportImage", options });
  }

  readExportOptions() {
    const width = Number(this.exportWidth.value);
    const height = Number(this.exportHeight.value);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) {
      this.exportError.textContent = t("Width and height must be 1-8192 px.");
      return null;
    }

    return {
      width,
      height,
      transparentBackground: this.exportTransparent.checked,
      backgroundColor: this.exportTransparent.checked ? undefined : this.exportBackground.value,
      includeGrid: document.getElementById("showGrid").checked,
      includeAxes: document.getElementById("showAxes").checked
    };
  }

  updateExportBackgroundState() {
    this.exportBackground.disabled = this.exportTransparent.checked;
  }

  renderIssues(issues) {
    this.issues.replaceChildren();
    if (!issues || issues.length === 0) {
      this.issues.appendChild(createListItem(t("No issues"), "issue-info"));
      return;
    }

    for (const issue of issues) {
      const item = document.createElement("li");
      item.className = `issue-${issue.severity}`;
      const text = `${t(issue.severity)}: ${issue.message}`;
      if (issue.resourceUri) {
        item.appendChild(createResourceButton(text, issue.resourceUri, issue.range));
        item.title = issue.resourceUri;
      } else {
        item.textContent = text;
      }
      this.issues.appendChild(item);
    }
  }

  renderDependencies(dependencies) {
    this.dependencies.replaceChildren();
    for (const dependency of dependencies ?? []) {
      const item = document.createElement("li");
      const kind = document.createElement("span");
      kind.className = "dependency-kind";
      kind.textContent = `${dependencyKindLabel(dependency.kind)}: `;
      item.appendChild(kind);
      item.appendChild(createResourceButton(formatDependencyUri(dependency.uri), dependency.uri));
      item.title = dependency.uri;
      this.dependencies.appendChild(item);
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    window.removeEventListener("message", this.onWindowMessage);
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    for (const dispose of this.disposables.splice(0)) {
      dispose();
    }
    this.detailsController.dispose();
    this.renderer.dispose();
  }
}

function normalizeColorInput(value) {
  if (/^#[\da-f]{6}$/i.test(value)) {
    return value;
  }

  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(computed);
  if (!match) {
    return "#1e1e1e";
  }

  return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
}

function toHex(value) {
  return Number(value).toString(16).padStart(2, "0");
}

function createListItem(text, className) {
  const item = document.createElement("li");
  item.className = className;
  item.textContent = text;
  return item;
}

function createResourceButton(text, uri, range) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "resource-link";
  button.textContent = text;
  button.addEventListener("click", () => vscode.postMessage({ type: "openResource", uri, range }));
  return button;
}

function formatDependencyUri(uri) {
  if (uri.startsWith("configuration:")) {
    return uri.slice("configuration:".length);
  }

  try {
    return decodeURIComponent(new URL(uri).pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
  } catch {
    return uri;
  }
}

function dependencyKindLabel(kind) {
  switch (kind) {
    case "model":
      return t("model");
    case "texture":
      return t("texture");
    case "textureMetadata":
      return t("texture metadata");
    case "packMetadata":
      return t("pack metadata");
    case "configuration":
      return t("configuration");
    default:
      return kind;
  }
}

new PreviewApp();
