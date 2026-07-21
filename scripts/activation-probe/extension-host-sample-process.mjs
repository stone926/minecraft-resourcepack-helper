import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateActivationProbeSample } from "./schema.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const canonicalExtensionHostSampleRunner = path.join(
  moduleDirectory,
  "extension-host-sample.mjs"
);

export function runExtensionHostSampleProcess(options) {
  const runnerPath = path.resolve(options.runnerPath ?? canonicalExtensionHostSampleRunner);
  const runnerArguments = [
    runnerPath,
    "--artifact",
    options.artifactPath,
    "--extension-root",
    options.extensionRoot,
    "--workspace",
    options.workspaceRoot,
    "--iteration",
    String(options.iteration),
    "--settle-ms",
    String(options.settleMilliseconds),
    "--sample-out",
    options.sampleOutput,
    "--probe-run-id",
    options.probeRunId,
    "--sample-id",
    options.sampleId,
    "--artifact-sha256",
    options.artifact.sha256,
    "--artifact-bytes",
    String(options.artifact.bytes),
    ...(options.codeExecutable ? ["--code", options.codeExecutable] : [])
  ];
  const result = spawnSync(process.execPath, runnerArguments, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMilliseconds ?? 180_000
  });
  try {
    const sample = readSample(result, options.sampleOutput);
    if (sample.iteration !== options.iteration
      || sample.probeRunId !== options.probeRunId
      || sample.sampleId !== options.sampleId
      || sample.artifact.sha256 !== options.artifact.sha256
      || sample.artifact.bytes !== options.artifact.bytes) {
      throw new Error("Extension Host sample did not echo its iteration, challenges, and artifact identity.");
    }
    if (sample.status === "ok"
      && pathIdentity(sample.activatedExtensionRoot) !== pathIdentity(options.extensionRoot)) {
      throw new Error("Extension Host sample activated a different extension root than the prepared artifact.");
    }
    const exitMatches = sample.status === "ok"
      ? result.status === 0
      : Number.isSafeInteger(result.status) && result.status !== 0;
    if (result.error || !exitMatches) {
      throw new Error([
        result.error?.message,
        `Extension Host runner exit status ${String(result.status)} contradicts sample status '${sample.status}'.`,
        result.stdout,
        result.stderr
      ].filter(Boolean).join("\n"));
    }
    if (sample.status === "error") {
      throw new Error([
        "Real Extension Host activation sample reported an error.",
        sample.error?.message,
        result.stdout,
        result.stderr
      ].filter(Boolean).join("\n"));
    }
    return sample;
  } catch (error) {
    const diagnosticPath = persistProcessDiagnostics(
      options.sampleOutput,
      runnerPath,
      runnerArguments,
      result
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nProcess diagnostics: ${diagnosticPath}`,
      { cause: error }
    );
  }
}

function persistProcessDiagnostics(sampleOutput, runnerPath, runnerArguments, result) {
  const diagnosticPath = `${path.resolve(sampleOutput)}.process.json`;
  mkdirSync(path.dirname(diagnosticPath), { recursive: true });
  writeFileSync(diagnosticPath, `${JSON.stringify({
    runnerPath,
    arguments: runnerArguments.slice(1),
    status: result.status,
    signal: result.signal,
    error: result.error ? {
      name: result.error.name,
      message: result.error.message,
      code: result.error.code
    } : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  }, null, 2)}\n`, "utf8");
  return diagnosticPath;
}

export function isCanonicalExtensionHostSampleRunner(value) {
  return pathIdentity(value) === pathIdentity(canonicalExtensionHostSampleRunner);
}

function readSample(result, sampleOutput) {
  if (!existsSync(sampleOutput)) {
    throw new Error([
      "Extension Host runner did not write its sample JSON.",
      result.error?.message,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  try {
    return validateActivationProbeSample(
      JSON.parse(readFileSync(sampleOutput, "utf8")),
      "extension-host"
    );
  } catch (error) {
    throw new Error("Extension Host runner wrote an invalid sample JSON.", { cause: error });
  }
}

function pathIdentity(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
