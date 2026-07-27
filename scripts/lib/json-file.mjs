import { existsSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Replaces a JSON report file atomically through a sibling `.tmp` file.
 * A stale temp entry is removed first, but never followed through symbolic
 * links or directories: anything other than a regular file is refused.
 */
export function writeJsonAtomically(fileName, value) {
  const temporary = `${fileName}.tmp`;
  if (existsSync(temporary) && !lstatSync(temporary).isFile()) {
    throw new Error(`Atomic JSON temp path is not a regular file: ${temporary}`);
  }
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, fileName);
}
