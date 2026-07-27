import path from "node:path";

/** Shared filesystem path comparison and containment helpers. */

/**
 * Resolves a path to one comparable identity; Windows folds case because its
 * default filesystems treat differently-cased paths as the same file.
 */
export function pathIdentity(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Compares two already-resolved paths under the platform case rules. */
export function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** True when candidate resolves to parent itself or a descendant of it. */
export function isPathAtOrBelow(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function assertPathAtOrBelow(parent, candidate, label) {
  if (!isPathAtOrBelow(parent, candidate)) {
    throw new Error(`${label} must stay inside ${parent}: ${candidate}`);
  }
}

/**
 * Report-friendly path display: forward-slash repository-relative form for
 * paths inside the root, otherwise a forward-slash absolute path.
 */
export function relativeOrAbsoluteFrom(rootDirectory) {
  return fileName => {
    const relative = path.relative(rootDirectory, fileName);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative.replaceAll("\\", "/")
      : path.resolve(fileName).replaceAll("\\", "/");
  };
}
