import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Resolves every VSCE output path against the repository root and creates its
 * parent directory before VSCE starts writing the archive.
 *
 * VSCE does not create a missing parent directory for --out. Keeping this at
 * the packaging boundary makes clean-checkout behavior independent of the
 * caller's shell and operating system.
 */
export function prepareVsixPackageArguments(args, repoRoot) {
  const normalized = [...args];
  const outputPaths = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];

    if ((argument === "--out" || argument === "-o") && normalized[index + 1]) {
      const outputPath = resolveOutputPath(normalized[index + 1], repoRoot);
      normalized[index + 1] = outputPath;
      outputPaths.push(outputPath);
      index += 1;
      continue;
    }

    if (argument.startsWith("--out=")) {
      const outputPath = resolveOutputPath(argument.slice("--out=".length), repoRoot);
      normalized[index] = `--out=${outputPath}`;
      outputPaths.push(outputPath);
    }
  }

  for (const outputPath of outputPaths) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
  }

  return normalized;
}

function resolveOutputPath(value, repoRoot) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(repoRoot, value);
}
