import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Hashes either one artifact file or a deterministic directory content tree. */
export function describeArtifact(artifactPath) {
  const details = statSync(artifactPath);
  if (details.isFile()) {
    const bytes = readFileSync(artifactPath);
    return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  if (!details.isDirectory()) {
    throw new Error(`Activation probe artifact must be a file or directory: ${artifactPath}`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const visit = directory => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(artifactPath, entryPath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        visit(entryPath);
      } else if (entry.isFile()) {
        const contents = readFileSync(entryPath);
        bytes += contents.length;
        hash.update(`file\0${relative}\0${contents.length}\0`);
        hash.update(contents);
      } else {
        throw new Error(`Activation probe artifact contains an unsupported entry: ${entryPath}`);
      }
    }
  };
  visit(artifactPath);
  return { bytes, sha256: hash.digest("hex") };
}
