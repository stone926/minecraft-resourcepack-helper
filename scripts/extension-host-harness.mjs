import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { windowsComSpecInvocation } from "./npm-invocation.mjs";

export function resolveCodeExecutable(explicit) {
  const candidates = [
    explicit,
    process.env.VSCODE_EXECUTABLE_PATH,
    process.platform === "win32" && process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe")
      : undefined,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe")
      : undefined,
    process.platform === "win32" ? findCommand("where.exe", "code.cmd") : findCommand("which", "code"),
    process.platform === "darwin" ? "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" : undefined
  ].filter(Boolean);
  const resolved = candidates
    .map(normalizeCodeCandidate)
    .find(candidate => existsSync(candidate));
  if (!resolved) {
    throw new Error(
      "A VS Code executable is required for the Extension Host harness; set VSCODE_EXECUTABLE_PATH."
    );
  }
  return path.resolve(resolved);
}

export function codeInvocation(executable, args) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    return windowsComSpecInvocation([executable, ...args]);
  }
  const prefix = process.platform !== "win32" && !process.env.DISPLAY
    ? findCommand("which", "xvfb-run")
    : undefined;
  return prefix
    ? { file: prefix, args: ["-a", executable, ...args] }
    : { file: executable, args };
}

export function extractZipArchive(fileName, destination, label = "ZIP archive") {
  const invocation = process.platform === "win32"
    ? { file: "tar", args: ["-xf", fileName, "-C", destination] }
    : { file: "unzip", args: ["-q", fileName, "-d", destination] };
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      `Unable to extract ${label} with ${invocation.file}.`,
      result.error?.message,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
}

function normalizeCodeCandidate(candidate) {
  const resolved = path.resolve(candidate);
  if (process.platform === "win32" && /[\\/]bin[\\/]code\.cmd$/i.test(resolved)) {
    const executable = path.resolve(path.dirname(resolved), "..", "Code.exe");
    return existsSync(executable) ? executable : resolved;
  }
  return resolved;
}

function findCommand(command, executable) {
  const result = spawnSync(command, [executable], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean);
}
