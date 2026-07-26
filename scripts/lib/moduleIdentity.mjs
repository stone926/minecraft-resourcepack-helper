import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** True when `moduleUrl`'s file is the Node entry script (win32 case-insensitive). */
export function isMainModule(moduleUrl) {
  if (!process.argv[1]) {
    return false;
  }
  const invoked = path.resolve(process.argv[1]);
  const scriptFile = fileURLToPath(moduleUrl);
  return process.platform === "win32"
    ? invoked.toLowerCase() === scriptFile.toLowerCase()
    : invoked === scriptFile;
}
