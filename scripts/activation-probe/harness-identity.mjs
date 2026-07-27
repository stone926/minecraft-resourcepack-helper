import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export const ACTIVATION_HARNESS_IDENTITY_ALGORITHM = "sha256-path-content-set-v1";
export const ACTIVATION_HARNESS_FILES = Object.freeze([
  "deferred-module-loads.cjs",
  "error-format.mjs",
  "event-classification.cjs",
  "extension-host-run.cjs",
  "extension-host-sample-process.mjs",
  "extension-host-sample.mjs",
  "harness-identity.mjs",
  "lib/instrumentation-core.cjs",
  "paired-schedule.mjs",
  "path-redaction.cjs",
  "prepared-vsix.mjs",
  "schema.mjs",
  "safe-output.mjs",
  "target-vscode-api.cjs",
  "../build-budget-config.mjs",
  "../build-budgets.json",
  "../extension-host-harness.mjs",
  "../lib/bundleEntries.cjs",
  "../lib/cli-args.mjs",
  "../lib/git.mjs",
  "../lib/parse.mjs",
  "../lib/paths.mjs",
  "../lib/stats.mjs",
  "../measure-json-only-activation-comparison.mjs",
  "../measure-json-only-activation.mjs",
  "../npm-invocation.mjs",
  "../verify-json-only-activation-budget.mjs",
  "../verify-json-only-activation-comparison.mjs",
  "../vsix-archive-metrics.mjs"
]);

export function createActivationHarnessIdentity() {
  const hash = createHash("sha256");
  let bytes = 0;
  const files = ACTIVATION_HARNESS_FILES.map(relativePath => {
    const normalizedPath = path.posix.normalize(relativePath);
    const contents = readFileSync(path.resolve(moduleDirectory, ...normalizedPath.split("/")));
    const fileSha256 = createHash("sha256").update(contents).digest("hex");
    bytes += contents.length;
    const record = JSON.stringify({ path: normalizedPath, bytes: contents.length, sha256: fileSha256 });
    hash.update(String(Buffer.byteLength(record, "utf8")));
    hash.update(":");
    hash.update(record);
    hash.update("\n");
    return Object.freeze({ path: normalizedPath, bytes: contents.length, sha256: fileSha256 });
  });
  return Object.freeze({
    algorithm: ACTIVATION_HARNESS_IDENTITY_ALGORITHM,
    sha256: hash.digest("hex"),
    bytes,
    files: Object.freeze(files)
  });
}
