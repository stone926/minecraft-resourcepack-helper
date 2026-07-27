"use strict";

// Bundle output paths for consumers that must stay CommonJS and dependency-free,
// such as the probes that run inside a packaged Extension Host. The ES-module
// single source (bundleEntryDefinitions in scripts/build-bundles.mjs) requires
// this file for its outfile values, so the two module systems cannot drift.
const bundleEntryOutfiles = Object.freeze({
  root: "bundle/extension.js",
  rsglHost: "bundle/features/rsglHost.js",
  server: "bundle/rsgl/server.js",
  worker: "bundle/rsgl/worker.js",
  modelPreview: "bundle/model-preview.js",
  cli: "packages/rsgl-cli/dist/rsgl.js"
});

module.exports = { bundleEntryOutfiles };
