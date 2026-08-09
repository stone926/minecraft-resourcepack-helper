import {
  registerResourceReferencePathResolver,
  type ResourceReferencePathResolutionContext
} from "../utils/pathGenerator";
import type { ScopedRegistration } from "../utils/scopedRegistry";
import { resolveCitReferenceAsset } from "./citAssetResolver";

export function registerCitResourcePathResolver(): ScopedRegistration {
  return registerResourceReferencePathResolver("cit", resolveCitResourceReferencePath);
}

function resolveCitResourceReferencePath(
  context: ResourceReferencePathResolutionContext
): string | null {
  return resolveCitReferenceAsset(context.document.fileName, context.reference, {
    pathExists: fileName => context.host.getPathExists(fileName),
    getPackRoot: fileName => context.host.getPackRoot(fileName),
    resolveTypedResource: () => context.resolveTypedResource()
  });
}
