export const combinedVsixRuntimeEntries = Object.freeze({
  root: "bundle/extension.js",
  rsglHost: "bundle/features/rsglHost.js",
  server: "bundle/rsgl/server.js",
  worker: "bundle/rsgl/worker.js",
  modelPreview: "bundle/model-preview.js"
});

export const combinedVsixRuntimeSourceMaps = Object.freeze(
  Object.values(combinedVsixRuntimeEntries).map(entryPath => `${entryPath}.map`).sort()
);

export const combinedVsixArtifactNames = Object.freeze({
  development: "combined-unminified.vsix",
  production: "combined-production.vsix"
});
