import { bundleEntryDefinitions, bundleTargetProfiles } from "./build-bundles.mjs";

export const combinedVsixRuntimeEntries = Object.freeze(Object.fromEntries(
  bundleTargetProfiles.main.map(id => [id, bundleEntryDefinitions[id].outfile])
));

export const combinedVsixRuntimeSourceMaps = Object.freeze(
  Object.values(combinedVsixRuntimeEntries).map(entryPath => `${entryPath}.map`).sort()
);

export const combinedVsixArtifactNames = Object.freeze({
  development: "combined-unminified.vsix",
  production: "combined-production.vsix"
});
