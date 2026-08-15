import { uniqueValues } from "../../../packages/mc-assets/src";
import {
  resourceSurfaceRegistry,
  type ResourceSurfaceDescriptor
} from "../../resources/resourceSurfaceRegistry";

/**
 * Surfaces whose files can affect an open model preview: models, CIT models,
 * textures, texture metadata, CIT properties, and pack metadata. Kept as ids so the preview
 * watcher derives its globs from the single resource-surface definition
 * instead of maintaining a parallel hand-written list.
 */
const previewWatcherSurfaceIds = [
  "models",
  "citModel",
  "textureAssets",
  "textureMetadata",
  "citProperties",
  "packMetadata"
];

/**
 * Workspace watcher globs for model previews, derived from the resource
 * surface registry. Watcher patterns are preferred; surfaces without explicit
 * watcher patterns fall back to their selector patterns, which may be broader
 * (e.g. models selects `**\/models/**` rather than only `assets/<ns>/models`).
 */
export function getModelPreviewWatcherPatterns(
  registry: readonly ResourceSurfaceDescriptor[] = resourceSurfaceRegistry
): string[] {
  return uniqueValues(previewWatcherSurfaceIds.flatMap(id => {
    const surface = registry.find(candidate => candidate.id === id);
    return [...(surface?.watcherPatterns ?? surface?.selectorPatterns ?? [])];
  }));
}
