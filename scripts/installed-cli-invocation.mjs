/**
 * Windows npm bin shims are batch files whose quoting changes across cmd.exe
 * invocation forms. The caller still verifies that npm created the shim, then
 * executes the manifest entry with Node. POSIX keeps executing the shim so the
 * smoke test continues to cover its shebang and executable mode.
 */
export function resolveInstalledCliInvocation(entry, shim, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    // cmd /s /c re-parses npm's batch shim quoting. The manifest entry is the
    // same program, while POSIX can still exercise its executable shim below.
    return {
      file: options.nodeExecutable ?? process.execPath,
      args: [entry, ...args]
    };
  }
  return { file: shim, args };
}
