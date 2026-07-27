import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Resolve npm without relying on Windows to discover npm.cmd through cmd.exe.
 * npm exposes the JavaScript CLI entry point to every npm script, so the same
 * Node executable can launch it directly on every platform.
 */
export function resolveNpmInvocation(args, options = {}) {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const npmExecPath = environment.npm_execpath;

  if (typeof npmExecPath === "string" && isNpmCliEntry(npmExecPath)) {
    return {
      file: nodeExecutable,
      args: [npmExecPath, ...args]
    };
  }

  if (platform === "win32") {
    return windowsComSpecInvocation(["npm", ...args], environment);
  }

  return { file: "npm", args };
}

/**
 * One shared cmd.exe invocation shape for Windows commands that must run
 * through ComSpec (npm fallback, .cmd/.bat shims). Arguments pass through a
 * conservative whitelist; anything else is double-quoted with `""` escapes.
 */
export function windowsComSpecInvocation(commandParts, environment = process.env) {
  return {
    file: environment.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", commandParts.map(quoteCmdArgument).join(" ")]
  };
}

/**
 * npm uses its cache even when packing or installing a local archive. Give
 * release smoke tests a disposable cache so a stale or partially restored
 * runner cache cannot make otherwise local packaging fail.
 */
export function npmEnvironmentWithCache(cacheDirectory, environment = process.env) {
  const result = {};
  for (const [name, value] of Object.entries(environment)) {
    if (name.toLowerCase() !== "npm_config_cache" && value !== undefined) {
      result[name] = value;
    }
  }
  result.npm_config_cache = path.resolve(cacheDirectory);
  return result;
}

function isNpmCliEntry(fileName) {
  return /(?:^|[\\/])npm-cli\.js$/i.test(fileName);
}

/** Runs one foreground npm command with a disposable npm cache. */
export function runNpm(args, cwd, cacheRoot) {
  const invocation = resolveNpmInvocation(args);
  execFileSync(invocation.file, invocation.args, {
    cwd,
    stdio: "inherit",
    env: npmEnvironmentWithCache(cacheRoot)
  });
}

function quoteCmdArgument(value) {
  return /^[A-Za-z0-9_./:=@+\\-]+$/.test(value)
    ? value
    : `"${value.replace(/"/g, '""')}"`;
}
