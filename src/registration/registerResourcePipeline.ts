import { registerCitResourcePathResolver } from "../cit/registerCitResourcePaths";
import { registerCitResourceReferenceExtractor } from "../cit/registerCitResourceReferences";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { workspaceResourcePathResolutionHost } from "../services/resourcePathResolutionHost";
import { registerDefaultModelTextureResolutionHost } from "../utils/modelTexture";
import { registerDefaultResourcePathResolutionHost } from "../utils/pathGenerator";
import { registerDefaultResourceReferenceHost } from "../utils/resourceReferences";
import { registerRelativeResourcePathResolver } from "../utils/resourceReferences/relativePathResolver";
import type { RegistrationScope } from "./registrationScope";

/** Installs the default adapters and feature-owned resource extensions. */
export function registerResourcePipeline(scope: RegistrationScope): void {
  scope.subscriptions.push(
    registerDefaultResourceReferenceHost(workspaceResourceCache),
    registerDefaultResourcePathResolutionHost(workspaceResourcePathResolutionHost),
    registerDefaultModelTextureResolutionHost(workspaceResourceCache),
    registerCitResourceReferenceExtractor(),
    registerCitResourcePathResolver(),
    registerRelativeResourcePathResolver()
  );
}
