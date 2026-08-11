import {
  registerResourceReferencePathResolver,
  type ResourceReferencePathResolutionContext
} from "../pathGenerator";
import type { ScopedRegistration } from "../scopedRegistry";
import { resolveRelativeResourcePathWithinNamespace } from "./relativeResourcePath";

/** Registers safe file-relative resolution used by quoted shader imports. */
export function registerRelativeResourcePathResolver(): ScopedRegistration {
  return registerResourceReferencePathResolver("relative", resolveRelativeResourcePath);
}

function resolveRelativeResourcePath(
  context: ResourceReferencePathResolutionContext
): string | null {
  const resolved = resolveRelativeResourcePathWithinNamespace(
    context.document.fileName,
    context.reference.value
  );
  if (!resolved) {
    return null;
  }
  return context.host.getPathExists(resolved) ? resolved : null;
}
