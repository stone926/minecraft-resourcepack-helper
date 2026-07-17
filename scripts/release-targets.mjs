import path from "node:path";

export const releaseTargets = Object.freeze({
  main: Object.freeze({
    id: "main",
    displayName: "Minecraft Resourcepack Helper",
    tagPrefix: "v",
    manifestPath: "package.json",
    lockPath: "package-lock.json",
    changelogPath: "CHANGELOG.md",
    publishKind: "marketplace",
    packageScript: "package:main:vsix"
  }),
  rsgl: Object.freeze({
    id: "rsgl",
    displayName: "RSGL",
    tagPrefix: "rsgl-v",
    manifestPath: "extensions/vscode-rsgl/package.json",
    lockPath: "extensions/vscode-rsgl/package-lock.json",
    changelogPath: "extensions/vscode-rsgl/CHANGELOG.md",
    publishKind: "marketplace",
    packageScript: "package:rsgl:vsix"
  }),
  "rsgl-cli": Object.freeze({
    id: "rsgl-cli",
    displayName: "RSGL CLI",
    tagPrefix: "rsgl-cli-v",
    manifestPath: "packages/rsgl-cli/package.json",
    lockPath: null,
    changelogPath: "packages/rsgl-cli/CHANGELOG.md",
    publishKind: "npm",
    packageScript: "package:rsgl-cli"
  })
});

export function releaseTarget(targetId) {
  const target = releaseTargets[targetId];
  if (!target) {
    throw new Error(`Unknown release target '${targetId}'. Expected one of: ${Object.keys(releaseTargets).join(", ")}.`);
  }
  return target;
}

export function releaseTag(target, version) {
  return `${target.tagPrefix}${version}`;
}

export function parseReleaseTag(tag) {
  for (const target of Object.values(releaseTargets).sort(
    (left, right) => right.tagPrefix.length - left.tagPrefix.length
  )) {
    const escapedPrefix = escapeRegExp(target.tagPrefix);
    const match = new RegExp(`^${escapedPrefix}(\\d+\\.\\d+\\.\\d+)$`).exec(tag);
    if (match) {
      return { target, version: match[1] };
    }
  }
  throw new Error(
    `Invalid release tag '${tag}'. Expected vX.Y.Z, rsgl-vX.Y.Z, or rsgl-cli-vX.Y.Z.`
  );
}

export function releaseAssetName(target, manifest, version) {
  if (target.publishKind === "marketplace") {
    return `${manifest.name}-${version}.vsix`;
  }
  return `${npmArchiveBaseName(manifest.name)}-${version}.tgz`;
}

export function npmArchiveBaseName(packageName) {
  return packageName
    .replace(/^@/, "")
    .split("/")
    .map(part => part.replaceAll("_", "-").replaceAll(".", "-"))
    .join("-");
}

export function targetDirectory(target) {
  return path.dirname(target.manifestPath);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
