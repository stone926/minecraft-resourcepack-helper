/**
 * Parse the deliberately narrow version format used by release tags.
 * Prerelease and build metadata are intentionally outside this contract.
 */
export function parsePlainSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
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
    return `${parsed.major + 1}.0.0`;
  }
  if (input === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  if (input === "patch") {
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
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
