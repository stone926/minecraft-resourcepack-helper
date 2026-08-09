import { Uri } from "vscode";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import type { ResourcePathResolutionHost } from "../utils/pathGenerator";
import { workspaceResourceCache } from "./workspaceResourceCache";

/** Default editor/workspace adapter for the pure resource path resolver. */
export const workspaceResourcePathResolutionHost: ResourcePathResolutionHost = {
  resolveResourcePath: request => workspaceResourceCache.resolveResourcePath(request),
  getPathExists: fileName => workspaceResourceCache.getPathExists(fileName),
  getPackRoot: fileName => workspaceResourceCache.getPackRoot(fileName),
  getResourceConfiguration,
  createFileUri: fileName => Uri.file(fileName)
};
