import * as path from "node:path";
import { parseAssetsPath } from "../../../packages/mc-assets/src";

/** Resolves a shader-relative path while confining it to the source namespace. */
export function resolveRelativeResourcePathWithinNamespace(
  sourceFileName: string,
  relativePath: string,
  allowNamespaceRoot = false
): string | null {
  const parsed = parseAssetsPath(sourceFileName);
  if (
    !parsed
    || relativePath.includes("\0")
    || path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
  ) {
    return null;
  }

  const namespaceRoot = path.join(parsed.assetsRoot, parsed.namespace);
  const resolved = path.resolve(path.dirname(sourceFileName), relativePath || ".");
  const relative = path.relative(namespaceRoot, resolved);
  if (
    path.isAbsolute(relative)
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || (!allowNamespaceRoot && relative === "")
  ) {
    return null;
  }
  return resolved;
}
