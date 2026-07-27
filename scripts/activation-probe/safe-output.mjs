import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync
} from "node:fs";
import path from "node:path";
import { requiredString } from "../lib/parse.mjs";
import { isPathAtOrBelow as isPathWithin, samePath } from "../lib/paths.mjs";

export function assertSafeEvidenceOutput(options) {
  if (!options || typeof options !== "object") {
    throw new Error("Evidence output safety options are required.");
  }
  const outputPath = path.resolve(requiredString(options.outputPath, "outputPath"));
  if (existsSync(outputPath)) {
    const outputLinkStat = lstatSync(outputPath);
    if (outputLinkStat.isSymbolicLink()) {
      throw new Error(`${options.label ?? "Evidence"} output must not be a symbolic link.`);
    }
    if (!outputLinkStat.isFile()) {
      throw new Error(`${options.label ?? "Evidence"} output must be a regular file path.`);
    }
    const outputStat = statSync(outputPath);
    if (outputStat.nlink > 1) {
      throw new Error(`${options.label ?? "Evidence"} output must not be a hard-linked file.`);
    }
  }

  const canonicalOutput = canonicalPotentialPath(outputPath);
  for (const protectedFileValue of options.protectedFiles ?? []) {
    const protectedFile = path.resolve(requiredString(protectedFileValue, "protected file"));
    if (samePath(canonicalOutput, canonicalPotentialPath(protectedFile))
      || sameExistingFile(outputPath, protectedFile)) {
      throw new Error(`${options.label ?? "Evidence"} output must not overwrite measured evidence.`);
    }
  }
  for (const protectedDirectoryValue of options.protectedDirectories ?? []) {
    const protectedDirectory = path.resolve(
      requiredString(protectedDirectoryValue, "protected directory")
    );
    if (isPathWithin(canonicalPotentialPath(protectedDirectory), canonicalOutput)) {
      throw new Error(`${options.label ?? "Evidence"} output must remain outside protected evidence directories.`);
    }
  }
}

export function canonicalPotentialPath(value) {
  const absolute = path.resolve(requiredString(value, "path"));
  const suffix = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Unable to resolve an existing ancestor for evidence path: ${absolute}`);
    }
    suffix.push(path.basename(cursor));
    cursor = parent;
  }
  let canonical = realpathSync.native(cursor);
  for (const segment of suffix.reverse()) {
    canonical = path.join(canonical, segment);
  }
  return canonical;
}

function sameExistingFile(left, right) {
  if (!existsSync(left) || !existsSync(right)) {
    return false;
  }
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  return leftStat.isFile() && rightStat.isFile()
    && leftStat.dev === rightStat.dev
    && leftStat.ino !== 0
    && leftStat.ino === rightStat.ino;
}

