#!/usr/bin/env node

import Module, { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  createExtensionContext,
  createVscodeStub,
  disposeExtensionContext
} from "./activation-probe/vscode-stub.mjs";

const [bundleArgument] = process.argv.slice(2);
if (!bundleArgument) {
  throw new Error("Usage: measure-cold-activation.mjs <extension-bundle.js>");
}

const bundlePath = path.resolve(bundleArgument);
const originalLoad = Module._load;
const vscode = createVscodeStub();
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  return request === "vscode"
    ? vscode
    : originalLoad.call(this, request, parent, isMain);
};

const context = createExtensionContext(resolveExtensionRoot(bundlePath), vscode);
const startedAt = performance.now();
try {
  const extension = createRequire(import.meta.url)(bundlePath);
  extension.activate(context);
  const milliseconds = performance.now() - startedAt;
  process.stdout.write(JSON.stringify({ milliseconds }));
} finally {
  disposeExtensionContext(context);
  Module._load = originalLoad;
}

function resolveExtensionRoot(bundlePath) {
  let directory = path.dirname(bundlePath);
  while (path.dirname(directory) !== directory) {
    if (path.basename(directory).toLowerCase() === "bundle") {
      return path.dirname(directory);
    }
    directory = path.dirname(directory);
  }
  return path.dirname(bundlePath);
}
