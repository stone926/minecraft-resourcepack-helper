/**
 * Parse the deliberately narrow version format used by release tags.
 * Prerelease and build metadata are intentionally outside this contract.
 */
export function parsePlainSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    return null;
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  return [major, minor, patch].every(Number.isSafeInteger)
    ? { major, minor, patch }
    : null;
}

export function comparePlainSemver(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

/** Resolve a bump name or explicit greater version without touching repository state. */
export function resolveNextReleaseVersion(currentVersion, input, options = {}) {
  const parsed = parsePlainSemver(currentVersion);
  if (!parsed) {
    const manifestPath = options.manifestPath ?? "Manifest";
    throw new Error(
      `${manifestPath} version is not a plain semver version: ${currentVersion}`
    );
  }
  if (input === "major") {
    return `${increment(parsed.major, "major")}.0.0`;
  }
  if (input === "minor") {
    return `${parsed.major}.${increment(parsed.minor, "minor")}.0`;
  }
  if (input === "patch") {
    return `${parsed.major}.${parsed.minor}.${increment(parsed.patch, "patch")}`;
  }
  const exact = parsePlainSemver(input);
  if (!exact) {
    throw new Error(`Invalid release version or bump type: ${input}`);
  }
  if (comparePlainSemver(exact, parsed) <= 0) {
    throw new Error(
      `Next version ${input} must be greater than current version ${currentVersion}.`
    );
  }
  return input;
}

function increment(value, component) {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Cannot bump ${component} beyond JavaScript's safe integer range.`);
  }
  return value + 1;
}
