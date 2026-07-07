import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Creates a unique temporary directory; callers are responsible for removing it. */
export function createTempDir(prefix = "mc-resourcepack-helper-rsgl-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Runs a callback with a fresh temporary directory and removes it afterwards. */
export function withTempDir<T>(fn: (root: string) => T, prefix?: string): T {
  const root = createTempDir(prefix);
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
