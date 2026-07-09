import * as THREE from "./vendor/three.module.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { vscode, t, clamp } from "./webviewApi.js";
import {
  createGeometry,
  createMissingMaterial,
  createMissingTexture,
  groupFacesByMaterial,
  paletteColor,
  viewDirection
} from "./previewScene.js";

const CAMERA_FIT_PADDING = 1.45;
const CAMERA_MIN_DISTANCE = 24;

export class PreviewRenderer {
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
    this.textureCache = new Map();
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
    this.pruneTextureCache();
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
      ? this.loadTexture(material)
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

  loadTexture(material) {
    const cacheKey = textureCacheKey(material);
    const cached = this.textureCache.get(cacheKey);
    if (cached) {
      this.texturePromises.push(cached.ready);
      return cached.texture;
    }

    const loader = new THREE.TextureLoader();
    const texture = loader.load(
      material.textureUri,
      () => this.requestRender(),
      undefined,
      error => vscode.postMessage({ type: "renderIssue", code: "Texture load failed: {0}", args: [String(error)] })
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.flipY = false;
    const ready = new Promise(resolve => {
      texture.onUpdate = () => resolve();
      setTimeout(resolve, 3000);
    });
    this.texturePromises.push(ready);
    this.textureCache.set(cacheKey, { texture, ready });
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
    this.disposeTextureCache();
    this.webgl.dispose();
    this.webgl.forceContextLoss?.();
  }

  pruneTextureCache() {
    if (!this.document) {
      this.disposeTextureCache();
      return;
    }

    const activeKeys = new Set(this.document.materials
      .filter(material => material.fallback === "texture" && material.textureUri)
      .map(material => textureCacheKey(material)));
    for (const [key, entry] of this.textureCache) {
      if (!activeKeys.has(key)) {
        entry.texture.dispose();
        this.textureCache.delete(key);
      }
    }
  }

  disposeTextureCache() {
    for (const entry of this.textureCache.values()) {
      entry.texture.dispose();
    }
    this.textureCache.clear();
  }
}

function getCssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function textureCacheKey(material) {
  return `${material.textureUri}\0${material.textureVersion ?? "unknown"}`;
}

function normalizeCaptureDimension(value, fallback) {
  if (!Number.isInteger(value) || value < 1) {
    return fallback;
  }

  return clamp(value, 1, 8192);
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
