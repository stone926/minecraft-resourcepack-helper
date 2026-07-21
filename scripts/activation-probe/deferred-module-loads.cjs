"use strict";

const Module = require("node:module");
const {
  isRsglModuleLoadEvent
} = require("./event-classification.cjs");

/**
 * Retains raw CommonJS resolution inputs while activation is being timed, then
 * resolves and serializes them only when the caller explicitly finalizes the
 * collection after its steady-state sample.
 */
function createDeferredModuleLoadRecorder(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("Deferred module-load recorder options are required.");
  }
  if (typeof options.createEvent !== "function") {
    throw new TypeError("Deferred module-load recorder requires createEvent.");
  }
  const resolveFilename = options.resolveFilename ?? Module._resolveFilename;
  if (typeof resolveFilename !== "function") {
    throw new TypeError("Deferred module-load recorder resolveFilename must be a function.");
  }

  const pending = [];
  let finalizedEvents;
  return Object.freeze({
    record(request, parent, isMain, durationMilliseconds) {
      if (finalizedEvents) {
        throw new Error("Cannot record a module load after deferred finalization.");
      }
      pending.push({
        request,
        parent: snapshotModuleParent(parent),
        isMain,
        durationMilliseconds
      });
    },
    finalize() {
      if (finalizedEvents) {
        return finalizedEvents;
      }
      const rawEvents = pending.splice(0);
      finalizedEvents = Object.freeze(rawEvents.map(rawEvent => {
        let resolved;
        try {
          resolved = Reflect.apply(resolveFilename, Module, [
            rawEvent.request,
            rawEvent.parent,
            rawEvent.isMain
          ]);
        } catch {
          // Module._load remains authoritative. Resolution diagnostics are
          // optional telemetry and must not alter activation behavior.
        }
        return options.createEvent(rawEvent, resolved);
      }));
      return finalizedEvents;
    },
    get pendingCount() {
      return pending.length;
    }
  });
}

function snapshotModuleParent(parent) {
  if (!parent || typeof parent !== "object") {
    return undefined;
  }
  return {
    id: typeof parent.id === "string" ? parent.id : undefined,
    filename: typeof parent.filename === "string" ? parent.filename : undefined,
    path: typeof parent.path === "string" ? parent.path : undefined,
    paths: Array.isArray(parent.paths) ? [...parent.paths] : undefined
  };
}

function createExtensionHostModuleLoadEvent(rawEvent, resolved, options) {
  if (!options || typeof options.sanitize !== "function") {
    throw new TypeError("Extension Host module event creation requires sanitize.");
  }
  const classify = options.classify ?? isRsglModuleLoadEvent;
  if (typeof classify !== "function") {
    throw new TypeError("Extension Host module event classify must be a function.");
  }
  const event = {
    request: options.sanitize(String(rawEvent.request)),
    resolved: options.sanitize(resolved),
    parent: options.sanitize(rawEvent.parent?.filename),
    durationMilliseconds: rawEvent.durationMilliseconds
  };
  event.rsgl = classify(event);
  return event;
}

module.exports = {
  createDeferredModuleLoadRecorder,
  createExtensionHostModuleLoadEvent,
  snapshotModuleParent
};
