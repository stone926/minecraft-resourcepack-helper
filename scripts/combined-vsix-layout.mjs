import { bundleEntryDefinitions, bundleTargetProfiles } from "./build-bundles.mjs";
import { combinedVsixArtifactNames } from "./combined-vsix-artifact-names.mjs";

export { combinedVsixArtifactNames } from "./combined-vsix-artifact-names.mjs";

export const combinedVsixRuntimeEntries = Object.freeze(Object.fromEntries(
  bundleTargetProfiles.main.map(id => [id, bundleEntryDefinitions[id].outfile])
));

export const combinedVsixRuntimeSourceMaps = Object.freeze(
  Object.values(combinedVsixRuntimeEntries).map(entryPath => `${entryPath}.map`).sort()
);
