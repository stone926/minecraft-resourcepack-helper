"use strict";

const path = require("node:path");

const hooks = Object.freeze({
  findFiles: "vscode.workspace.findFiles",
  readDirectory: "vscode.workspace.fs.readDirectory",
  createFileSystemWatcher: "vscode.workspace.createFileSystemWatcher"
});

function createTargetVscodeApiInstrumentation(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("Target VS Code API instrumentation options are required.");
  }
  if (typeof options.extensionRoot !== "string" || options.extensionRoot.length === 0) {
    throw new TypeError("Target VS Code API instrumentation requires extensionRoot.");
  }

  const platform = options.platform ?? process.platform;
  const patchedApis = new WeakSet();
  const installedHooks = new Set();
  const restorers = [];
  let active = true;

  function observeModuleLoad(request, parentFileName, api) {
    if (!active
      || request !== "vscode"
      || !isPathWithinRoot(options.extensionRoot, parentFileName, platform)
      || !isObject(api)
      || patchedApis.has(api)) {
      return false;
    }

    patchedApis.add(api);
    instrumentApi(api);
    return true;
  }

  function instrumentApi(api) {
    const workspace = api.workspace;
    installDirectMethod(workspace, "findFiles", hooks.findFiles);
    installNestedMethod(workspace, "fs", "readDirectory", hooks.readDirectory);
    installDirectMethod(
      workspace,
      "createFileSystemWatcher",
      hooks.createFileSystemWatcher
    );
  }

  function installDirectMethod(owner, property, hook) {
    try {
      if (!isObject(owner)) {
        throw new Error("Target extension workspace API is unavailable.");
      }
      const original = Reflect.get(owner, property);
      if (typeof original !== "function") {
        throw new Error("Target extension API method is unavailable.");
      }
      const wrapper = function instrumentedTargetVscodeApi(...args) {
        recordCall(hook, args);
        return Reflect.apply(original, this, args);
      };
      const installation = replaceProperty(owner, property, wrapper);
      registerInstallation(hook, installation);
    } catch (error) {
      warn(hook, error);
    }
  }

  function installNestedMethod(container, objectProperty, methodProperty, hook) {
    try {
      if (!isObject(container)) {
        throw new Error("Target extension workspace API is unavailable.");
      }
      const originalObject = Reflect.get(container, objectProperty);
      const original = isObject(originalObject)
        ? Reflect.get(originalObject, methodProperty)
        : undefined;
      if (!isObject(originalObject) || typeof original !== "function") {
        throw new Error("Target extension nested API method is unavailable.");
      }
      const wrapper = function instrumentedTargetVscodeNestedApi(...args) {
        recordCall(hook, args);
        return Reflect.apply(original, originalObject, args);
      };
      const replacement = cloneWithMethodReplacement(
        originalObject,
        methodProperty,
        wrapper
      );
      const installation = replaceProperty(container, objectProperty, replacement);
      registerInstallation(hook, installation);
    } catch (error) {
      warn(hook, error);
    }
  }

  function registerInstallation(hook, installation) {
    restorers.push({ hook, restore: installation.restore });
    if (!installedHooks.has(hook)) {
      installedHooks.add(hook);
      safelyNotify(options.onHookInstalled, hook, hook);
    }
  }

  function recordCall(hook, args) {
    if (!active) {
      return;
    }
    safelyNotify(options.onCall, { hook, args }, hook);
  }

  function safelyNotify(callback, value, hook) {
    if (typeof callback !== "function") {
      return;
    }
    try {
      callback(value);
    } catch (error) {
      warn(hook, error);
    }
  }

  function warn(hook, error) {
    if (typeof options.onWarning !== "function") {
      return;
    }
    try {
      options.onWarning({ hook, message: errorMessage(error) });
    } catch {
      // Instrumentation diagnostics must never alter the target extension.
    }
  }

  function stop() {
    if (!active) {
      return;
    }
    active = false;
    for (const { hook, restore } of restorers.splice(0).reverse()) {
      try {
        restore();
      } catch (error) {
        warn(hook, error);
      }
    }
  }

  return Object.freeze({
    observeModuleLoad,
    stop,
    get active() {
      return active;
    }
  });
}

function replaceProperty(owner, property, replacement) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(owner, property);
  const originalValue = Reflect.get(owner, property);
  const replacementDescriptor = descriptorWithReplacement(
    originalDescriptor,
    replacement
  );
  Object.defineProperty(owner, property, replacementDescriptor);
  if (Reflect.get(owner, property) !== replacement) {
    restoreDescriptor(owner, property, originalDescriptor);
    throw new Error(`Target extension API rejected instrumentation for ${String(property)}.`);
  }

  return {
    restore() {
      if (Reflect.get(owner, property) !== replacement) {
        throw new Error(`Target extension API changed before restoring ${String(property)}.`);
      }
      restoreDescriptor(owner, property, originalDescriptor);
      if (Reflect.get(owner, property) !== originalValue) {
        throw new Error(`Target extension API restore failed for ${String(property)}.`);
      }
    }
  };
}

function descriptorWithReplacement(originalDescriptor, replacement) {
  if (!originalDescriptor) {
    return {
      configurable: true,
      enumerable: true,
      value: replacement,
      writable: true
    };
  }
  if ("value" in originalDescriptor) {
    if (!originalDescriptor.configurable && !originalDescriptor.writable) {
      throw new Error("Target extension API property is not replaceable.");
    }
    return { ...originalDescriptor, value: replacement };
  }
  if (!originalDescriptor.configurable) {
    throw new Error("Target extension API accessor is not configurable.");
  }
  return {
    ...originalDescriptor,
    get() {
      return replacement;
    }
  };
}

function restoreDescriptor(owner, property, descriptor) {
  if (descriptor) {
    Object.defineProperty(owner, property, descriptor);
    return;
  }
  if (!Reflect.deleteProperty(owner, property)) {
    throw new Error(`Unable to remove temporary target API property ${String(property)}.`);
  }
}

function cloneWithMethodReplacement(original, property, replacement) {
  const descriptors = Object.getOwnPropertyDescriptors(original);
  descriptors[property] = descriptorForClone(
    Object.getOwnPropertyDescriptor(original, property),
    replacement
  );
  const clone = Object.create(Object.getPrototypeOf(original), descriptors);
  if (!Object.isExtensible(original)) {
    Object.preventExtensions(clone);
  }
  return clone;
}

function descriptorForClone(originalDescriptor, replacement) {
  if (!originalDescriptor) {
    return {
      configurable: true,
      enumerable: true,
      value: replacement,
      writable: true
    };
  }
  if ("value" in originalDescriptor) {
    return { ...originalDescriptor, value: replacement };
  }
  return {
    ...originalDescriptor,
    get() {
      return replacement;
    }
  };
}

function isPathWithinRoot(rootPath, fileName, platform = process.platform) {
  if (typeof rootPath !== "string" || rootPath.length === 0
    || typeof fileName !== "string" || fileName.length === 0) {
    return false;
  }
  try {
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const normalizeCase = value => platform === "win32" ? value.toLowerCase() : value;
    const root = normalizeCase(pathApi.resolve(rootPath));
    const file = normalizeCase(pathApi.resolve(fileName));
    const relative = pathApi.relative(root, file);
    return relative === ""
      || (relative !== ".."
        && !relative.startsWith(`..${pathApi.sep}`)
        && !pathApi.isAbsolute(relative));
  } catch {
    return false;
  }
}

function isObject(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  createTargetVscodeApiInstrumentation,
  isPathWithinRoot
};
