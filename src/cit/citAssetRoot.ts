import * as fs from "node:fs";
import * as path from "node:path";

/** Resolves CIT data assets from both compiled tests and the staged VSIX bundle. */
export function resolveBundledCitAssetRoot(): string {
  const candidates = [
    path.join(__dirname, "..", "assets", "cit"),
    path.join(__dirname, "..", "..", "assets", "cit"),
    path.join(__dirname, "..", "..", "..", "assets", "cit")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  // Keep a missing installed asset anchored to the extension instead of
  // accidentally consuming an assets/cit directory from the user's workspace.
  return candidates[0];
}
