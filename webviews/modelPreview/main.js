import * as THREE from "./vendor/three.module.js";
import { OrbitControls } from "./vendor/OrbitControls.js";

const vscode = acquireVsCodeApi();
const CAMERA_FIT_PADDING = 1.45;
const CAMERA_MIN_DISTANCE = 24;
const DETAILS_MIN_SIZE = 72;
const DETAILS_KEYBOARD_STEP = 24;
const DETAILS_STACKED_QUERY = "(max-width: 780px)";
const MISSING_TEXTURE_SIZE = 16;
const MISSING_TEXTURE_MAGENTA = [248, 0, 248];
const MISSING_TEXTURE_BLACK = [0, 0, 0];
const l10n = Object.freeze(globalThis.__MC_RES_HELPER_L10N__ ?? {});

function t(key, ...args) {
  const message = l10n[key] ?? key;
  return message.replace(/\{(\d+)\}/g, (match, index) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}

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

class DetailsPanelController {
  constructor(layout, panel, resizer) {
    this.layout = layout;
    this.panel = panel;
    this.resizer = resizer;
    this.stackedQuery = window.matchMedia(DETAILS_STACKED_QUERY);
    this.dragging = false;
    this.disposables = [];

    this.installToggles();
    this.installResizer();
    this.updateOrientation();
    this.updateCollapsedLayout();
    this.addDomListener(this.stackedQuery, "change", () => this.updateOrientation());
  }

  addDomListener(target, type, listener) {
    target.addEventListener(type, listener);
    this.disposables.push(() => target.removeEventListener(type, listener));
  }

  installToggles() {
    for (const button of document.querySelectorAll("[data-details-toggle]")) {
      this.addDomListener(button, "click", () => this.toggleSection(button));
    }
  }

  toggleSection(button) {
    const section = button.closest("[data-details-section]");
    if (!section) {
      return;
    }

    const expanded = button.getAttribute("aria-expanded") !== "false";
    section.classList.toggle("is-collapsed", expanded);
    button.setAttribute("aria-expanded", String(!expanded));
    this.updateCollapsedLayout();
  }

  installResizer() {
    this.addDomListener(this.resizer, "pointerdown", event => this.startResize(event));
    this.addDomListener(this.resizer, "keydown", event => this.resizeWithKeyboard(event));
  }

  startResize(event) {
    event.preventDefault();
    this.dragging = true;
    this.resizer.classList.add("is-dragging");
    this.resizer.setPointerCapture(event.pointerId);

    const move = moveEvent => this.resizeFromPointer(moveEvent);
    const stop = () => {
      this.dragging = false;
      this.resizer.classList.remove("is-dragging");
      this.resizer.removeEventListener("pointermove", move);
      this.resizer.removeEventListener("pointerup", stop);
      this.resizer.removeEventListener("pointercancel", stop);
    };

    this.resizer.addEventListener("pointermove", move);
    this.resizer.addEventListener("pointerup", stop);
    this.resizer.addEventListener("pointercancel", stop);
    this.disposables.push(() => {
      this.resizer.removeEventListener("pointermove", move);
      this.resizer.removeEventListener("pointerup", stop);
      this.resizer.removeEventListener("pointercancel", stop);
    });
  }

  resizeFromPointer(event) {
    const rect = this.layout.getBoundingClientRect();
    if (this.isStacked()) {
      this.setDetailsHeight(rect.bottom - event.clientY);
      return;
    }

    this.setDetailsWidth(rect.right - event.clientX);
  }

  resizeWithKeyboard(event) {
    const keyDelta = keyboardResizeDelta(event.key);
    if (keyDelta === 0) {
      return;
    }

    event.preventDefault();
    if (this.isStacked()) {
      this.setDetailsHeight(this.panel.getBoundingClientRect().height + keyDelta);
      return;
    }

    this.setDetailsWidth(this.panel.getBoundingClientRect().width + keyDelta);
  }

  setDetailsHeight(height) {
    const layoutHeight = this.layout.getBoundingClientRect().height;
    const maxHeight = Math.max(DETAILS_MIN_SIZE, Math.floor(layoutHeight * 0.68));
    this.layout.style.setProperty("--details-height", `${clamp(height, DETAILS_MIN_SIZE, maxHeight)}px`);
    this.layout.classList.add("details-has-manual-height");
  }

  setDetailsWidth(width) {
    const layoutWidth = this.layout.getBoundingClientRect().width;
    const maxWidth = Math.max(220, Math.floor(layoutWidth * 0.58));
    this.layout.style.setProperty("--details-width", `${clamp(width, 220, maxWidth)}px`);
  }

  updateOrientation() {
    this.resizer.setAttribute("aria-orientation", this.isStacked() ? "horizontal" : "vertical");
    this.updateCollapsedLayout();
  }

  isStacked() {
    return this.stackedQuery.matches;
  }

  updateCollapsedLayout() {
    const sections = [...this.panel.querySelectorAll("[data-details-section]")];
    const allCollapsed = sections.length > 0 && sections.every(section => section.classList.contains("is-collapsed"));
    this.layout.classList.toggle("details-all-collapsed", allCollapsed);
  }

  dispose() {
    for (const dispose of this.disposables.splice(0)) {
      dispose();
    }
  }
}

class PreviewRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.scene.background = new THREE.Color(getCssColor("--vscode-editor-background", "#1e1e1e"));
    this.webgl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true
    });
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.cameraMode = "perspective";
    this.displayMode = "textured";
    this.viewPreset = "default";
    this.document = null;
    this.renderQueued = false;
    this.animationFrame = 0;
    this.disposed = false;
    this.backgroundColor = getCssColor("--vscode-editor-background", "#1e1e1e");
    this.texturePromises = [];
    this.disposables = [];
    this.grid = new THREE.GridHelper(32, 16, 0x5f6f7a, 0x303842);
    this.grid.position.set(8, 0, 8);
    this.axes = new THREE.AxesHelper(18);
    this.scene.add(this.grid);
    this.scene.add(this.axes);
    this.addLights();
    this.createCamera();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
    this.requestRender();
  }

  getCanvasSize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    return {
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height))
    };
  }

  getBackgroundColor() {
    return this.backgroundColor;
  }

  addLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x4f5660, 2.4));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
    keyLight.position.set(32, 48, 32);
    this.scene.add(keyLight);
  }

  createCamera() {
    const size = this.canvas.parentElement.getBoundingClientRect();
    const aspect = Math.max(1, size.width) / Math.max(1, size.height);
    this.camera = this.cameraMode === "perspective"
      ? new THREE.PerspectiveCamera(35, aspect, 0.1, 1000)
      : new THREE.OrthographicCamera(-16 * aspect, 16 * aspect, 16, -16, 0.1, 1000);
    this.controls?.dispose();
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", () => this.requestRender());
    this.fitCamera();
  }

  setDocument(document) {
    if (this.disposed) {
      return;
    }
    this.document = document;
    this.rebuildScene();
  }

  setDisplayMode(mode) {
    if (this.disposed) {
      return;
    }
    this.displayMode = mode;
    this.rebuildScene();
  }

  setGridVisible(visible) {
    this.grid.visible = visible;
    this.requestRender();
  }

  setAxesVisible(visible) {
    this.axes.visible = visible;
    this.requestRender();
  }

  setViewPreset(preset) {
    this.viewPreset = preset;
    this.fitCamera();
  }

  resetView() {
    this.viewPreset = "default";
    const select = document.getElementById("viewPreset");
    select.value = "default";
    this.fitCamera();
  }

  toggleCameraMode() {
    this.cameraMode = this.cameraMode === "perspective" ? "orthographic" : "perspective";
    this.createCamera();
    this.requestRender();
    return this.cameraMode;
  }

  rebuildScene() {
    this.disposeSceneObjects();
    if (!this.document) {
      this.requestRender();
      return;
    }

    const materialMap = this.createMaterials(this.document.materials);
    const groups = groupFacesByMaterial(this.document.meshes);

    for (const [materialId, faces] of groups) {
      const geometry = createGeometry(faces);
      const material = materialMap.get(materialId) ?? createMissingMaterial(this.displayMode);
      const mesh = new THREE.Mesh(geometry, material);
      this.root.add(mesh);
      this.disposables.push(geometry, material);
    }

    this.fitCamera();
    this.requestRender();
  }

  createMaterials(materials) {
    const map = new Map();
    materials.forEach((material, index) => {
      map.set(material.id, this.createMaterial(material, index));
    });
    return map;
  }

  createMaterial(material, index) {
    if (this.displayMode === "solid") {
      return new THREE.MeshStandardMaterial({
        color: paletteColor(index),
        roughness: 0.8,
        metalness: 0,
        side: THREE.FrontSide
      });
    }

    if (this.displayMode === "wireframe") {
      return new THREE.MeshBasicMaterial({
        color: 0xd6dee8,
        wireframe: true,
        side: THREE.FrontSide
      });
    }

    const texture = material.fallback === "texture" && material.textureUri
      ? this.loadTexture(material.textureUri)
      : createMissingTexture();
    if (!(material.fallback === "texture" && material.textureUri)) {
      this.disposables.push(texture);
    }

    return new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.95,
      metalness: 0,
      transparent: material.transparent,
      alphaTest: 0.1,
      side: THREE.FrontSide
    });
  }

  loadTexture(uri) {
    const loader = new THREE.TextureLoader();
    const texture = loader.load(
      appendCacheBust(uri),
      () => this.requestRender(),
      undefined,
      error => vscode.postMessage({ type: "renderIssue", code: "Texture load failed: {0}", args: [String(error)] })
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.flipY = false;
    this.texturePromises.push(new Promise(resolve => {
      texture.onUpdate = () => resolve();
      setTimeout(resolve, 3000);
    }));
    this.disposables.push(texture);
    return texture;
  }

  fitCamera() {
    const bounds = this.document?.bounds ?? { min: [0, 0, 0], max: [16, 16, 16] };
    const min = new THREE.Vector3(...bounds.min);
    const max = new THREE.Vector3(...bounds.max);
    const center = min.clone().add(max).multiplyScalar(0.5);
    const size = max.clone().sub(min);
    const radius = Math.max(size.length() * 0.5, 1) * CAMERA_FIT_PADDING;
    const direction = viewDirection(this.viewPreset);
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
    const distance = this.camera.isPerspectiveCamera
      ? this.getPerspectiveFitDistance(radius, aspect)
      : Math.max(radius * 2.8, CAMERA_MIN_DISTANCE);

    if (this.cameraMode === "orthographic") {
      const half = Math.max(radius, 8);
      this.camera.left = -half * aspect;
      this.camera.right = half * aspect;
      this.camera.top = half;
      this.camera.bottom = -half;
      this.camera.updateProjectionMatrix();
    }

    this.camera.position.copy(center.clone().add(direction.multiplyScalar(distance)));
    this.camera.near = 0.1;
    this.camera.far = Math.max(1000, distance * 8);
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.requestRender();
  }

  getPerspectiveFitDistance(radius, aspect) {
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
    const fitFov = Math.max(0.1, Math.min(verticalFov, horizontalFov));
    return Math.max(radius / Math.sin(fitFov / 2), CAMERA_MIN_DISTANCE);
  }

  resize() {
    if (this.disposed) {
      return;
    }

    const { width, height } = this.getCanvasSize();
    this.webgl.setSize(width, height, false);

    if (this.camera.isPerspectiveCamera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    } else {
      this.fitCamera();
    }

    this.requestRender();
  }

  requestRender() {
    if (this.disposed || this.renderQueued) {
      return;
    }

    this.renderQueued = true;
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = 0;
      if (this.disposed) {
        return;
      }
      this.renderQueued = false;
      this.webgl.render(this.scene, this.camera);
    });
  }

  async capture(options) {
    if (this.disposed) {
      throw new Error(t("Renderer has been disposed"));
    }

    await Promise.allSettled(this.texturePromises);
    if (this.disposed) {
      throw new Error(t("Renderer has been disposed"));
    }

    const originalGrid = this.grid.visible;
    const originalAxes = this.axes.visible;
    const originalBackground = this.scene.background;
    const originalCameraProjection = captureCameraProjection(this.camera);
    if (typeof options.includeGrid === "boolean") {
      this.grid.visible = options.includeGrid;
    }
    if (typeof options.includeAxes === "boolean") {
      this.axes.visible = options.includeAxes;
    }

    const { width: originalWidth, height: originalHeight } = this.getCanvasSize();
    const width = normalizeCaptureDimension(options.width, originalWidth);
    const height = normalizeCaptureDimension(options.height, originalHeight);

    if (options.transparentBackground) {
      this.scene.background = null;
    } else if (options.backgroundColor) {
      this.scene.background = new THREE.Color(options.backgroundColor);
    }

    this.webgl.setSize(width, height, false);
    applyCameraAspect(this.camera, width / height);
    this.webgl.render(this.scene, this.camera);
    const dataUri = this.webgl.domElement.toDataURL("image/png");

    restoreCameraProjection(this.camera, originalCameraProjection);
    this.scene.background = originalBackground;
    this.grid.visible = originalGrid;
    this.axes.visible = originalAxes;
    this.webgl.setSize(originalWidth, originalHeight, false);
    this.requestRender();
    return dataUri;
  }

  disposeSceneObjects() {
    while (this.root.children.length > 0) {
      this.root.remove(this.root.children[0]);
    }

    for (const disposable of this.disposables) {
      disposable.dispose?.();
    }
    this.disposables = [];
    this.texturePromises = [];
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
    this.resizeObserver.disconnect();
    this.controls?.dispose();
    this.disposeSceneObjects();
    disposeObject3d(this.grid);
    disposeObject3d(this.axes);
    this.webgl.dispose();
    this.webgl.forceContextLoss?.();
  }
}

function groupFacesByMaterial(meshes) {
  const groups = new Map();
  for (const mesh of meshes ?? []) {
    for (const face of mesh.faces ?? []) {
      const group = groups.get(face.materialId) ?? [];
      group.push(face);
      groups.set(face.materialId, group);
    }
  }
  return groups;
}

function createGeometry(faces) {
  const positions = [];
  const uvs = [];
  const indices = [];

  for (const face of faces) {
    const base = positions.length / 3;
    for (const position of face.positions) {
      positions.push(position[0], position[1], position[2]);
    }
    for (const uv of face.uvs) {
      uvs.push(uv[0] / 16, uv[1] / 16);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createMissingMaterial(displayMode) {
  if (displayMode === "wireframe") {
    return new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, side: THREE.FrontSide });
  }

  return new THREE.MeshStandardMaterial({ color: 0xff00ff, roughness: 0.95, side: THREE.FrontSide });
}

function createMissingTexture() {
  const size = MISSING_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const color = (y < size / 2) !== (x < size / 2)
        ? MISSING_TEXTURE_MAGENTA
        : MISSING_TEXTURE_BLACK;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function viewDirection(preset) {
  switch (preset) {
    case "front":
      return new THREE.Vector3(0, 0.15, 1).normalize();
    case "back":
      return new THREE.Vector3(0, 0.15, -1).normalize();
    case "left":
      return new THREE.Vector3(-1, 0.15, 0).normalize();
    case "right":
      return new THREE.Vector3(1, 0.15, 0).normalize();
    case "top":
      return new THREE.Vector3(0, 1, 0.001).normalize();
    case "bottom":
      return new THREE.Vector3(0, -1, 0.001).normalize();
    default:
      return new THREE.Vector3(1, 0.75, 1).normalize();
  }
}

function paletteColor(index) {
  const colors = [0x91c4f2, 0xf2a65a, 0x7bd88f, 0xd6a3fb, 0xf26d6d, 0xf2df7e, 0x70d6d0];
  return colors[index % colors.length];
}

function getCssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function appendCacheBust(uri) {
  return `${uri}${uri.includes("?") ? "&" : "?"}v=${Date.now()}`;
}

function normalizeCaptureDimension(value, fallback) {
  if (!Number.isInteger(value) || value < 1) {
    return fallback;
  }

  return clamp(value, 1, 8192);
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

function captureCameraProjection(camera) {
  if (camera.isPerspectiveCamera) {
    return {
      type: "perspective",
      aspect: camera.aspect
    };
  }

  return {
    type: "orthographic",
    left: camera.left,
    right: camera.right,
    top: camera.top,
    bottom: camera.bottom
  };
}

function applyCameraAspect(camera, aspect) {
  if (camera.isPerspectiveCamera) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    return;
  }

  const halfHeight = Math.max(0.01, (camera.top - camera.bottom) / 2);
  const halfWidth = halfHeight * aspect;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.updateProjectionMatrix();
}

function restoreCameraProjection(camera, projection) {
  if (projection.type === "perspective" && camera.isPerspectiveCamera) {
    camera.aspect = projection.aspect;
  } else if (projection.type === "orthographic" && camera.isOrthographicCamera) {
    camera.left = projection.left;
    camera.right = projection.right;
    camera.top = projection.top;
    camera.bottom = projection.bottom;
  }
  camera.updateProjectionMatrix();
}

function disposeObject3d(object) {
  object.geometry?.dispose?.();
  if (Array.isArray(object.material)) {
    object.material.forEach(material => material.dispose?.());
  } else {
    object.material?.dispose?.();
  }
}

function keyboardResizeDelta(key) {
  switch (key) {
    case "ArrowUp":
    case "ArrowLeft":
      return DETAILS_KEYBOARD_STEP;
    case "ArrowDown":
    case "ArrowRight":
      return -DETAILS_KEYBOARD_STEP;
    default:
      return 0;
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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
    case "configuration":
      return t("configuration");
    default:
      return kind;
  }
}

new PreviewApp();
