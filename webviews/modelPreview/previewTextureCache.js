import {
  NearestFilter,
  SRGBColorSpace,
  TextureLoader
} from "three";
import { vscode } from "./webviewApi.js";
import { webviewToHostMessageTypes } from "./messageTypes.js";

const TEXTURE_LOAD_SETTLE_MILLISECONDS = 3000;

export class PreviewTextureCache {
  constructor(requestRender) {
    this.requestRender = requestRender;
    this.entries = new Map();
  }

  acquire(material) {
    const key = textureCacheKey(material);
    const cached = this.entries.get(key);
    if (cached) {
      return cached;
    }

    let resolveOutcome;
    let settled = false;
    const outcome = new Promise(resolve => {
      resolveOutcome = resolve;
    });
    const entry = {
      active: true,
      state: "loading",
      texture: null,
      outcome,
      ready: null,
      deactivate: null
    };
    const settle = (state, loaded) => {
      if (settled) {
        return;
      }
      settled = true;
      entry.state = state;
      resolveOutcome(loaded);
      if (entry.active) {
        this.requestRender();
      }
    };
    entry.deactivate = () => {
      if (!entry.active) {
        return;
      }
      entry.active = false;
      settle("inactive", false);
    };

    const loader = new TextureLoader();
    entry.texture = loader.load(
      material.textureUri,
      () => {
        if (entry.active) {
          settle("ready", true);
        }
      },
      undefined,
      error => {
        if (!entry.active) {
          return;
        }
        vscode.postMessage({
          type: webviewToHostMessageTypes.renderIssue,
          code: "Texture load failed: {0}",
          args: [String(error)]
        });
        settle("failed", false);
      }
    );
    entry.texture.colorSpace = SRGBColorSpace;
    entry.texture.magFilter = NearestFilter;
    entry.texture.minFilter = NearestFilter;
    entry.texture.flipY = false;
    entry.ready = settleWithin(outcome, TEXTURE_LOAD_SETTLE_MILLISECONDS);
    this.entries.set(key, entry);
    return entry;
  }

  prune(materials) {
    const activeKeys = new Set(materials
      .filter(material => material.fallback === "texture" && material.textureUri)
      .map(material => textureCacheKey(material)));
    for (const [key, entry] of this.entries) {
      if (!activeKeys.has(key)) {
        disposeEntry(entry);
        this.entries.delete(key);
      }
    }
  }

  dispose() {
    for (const entry of this.entries.values()) {
      disposeEntry(entry);
    }
    this.entries.clear();
  }
}

function disposeEntry(entry) {
  entry.deactivate();
  entry.texture.dispose();
}

function textureCacheKey(material) {
  return `${material.textureUri}\0${material.textureVersion ?? "unknown"}`;
}

function settleWithin(outcome, milliseconds) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), milliseconds);
    outcome.then(finish);
  });
}
