import * as assert from "node:assert/strict";
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns
} from "node:child_process";

export const defaultTestProcessTimeoutMs = 60_000;
export const defaultTestProcessMaxBufferBytes = 16 * 1024 * 1024;
export const defaultTestProcessMochaTimeoutMs = defaultTestProcessTimeoutMs + 5_000;

export type TestProcessOptions = Omit<
  SpawnSyncOptionsWithStringEncoding,
  "encoding" | "maxBuffer" | "stdio" | "timeout" | "windowsHide"
> & {
  maxBuffer?: number;
  timeout?: number;
};

export interface TestProcessResult extends SpawnSyncReturns<string> {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
}

/**
 * Runs a foreground test process with bounded execution and captured UTF-8
 * output. An OS launch failure, timeout, or output-buffer overflow is reported
 * immediately with both output streams so a failed CI run remains actionable.
 */
export function runTestProcessSync(
  command: string,
  args: readonly string[] = [],
  options: TestProcessOptions = {}
): TestProcessResult {
  const {
    maxBuffer = defaultTestProcessMaxBufferBytes,
    timeout = defaultTestProcessTimeoutMs,
    ...spawnOptions
  } = options;
  const result = spawnSync(command, [...args], {
    ...spawnOptions,
    encoding: "utf8",
    maxBuffer,
    stdio: "pipe",
    timeout,
    windowsHide: true
  });
  const enriched: TestProcessResult = {
    ...result,
    command,
    arguments: [...args],
    timeoutMs: timeout
  };

  if (result.error) {
    assert.fail(testProcessDiagnostic(enriched, "Test process failed to run"));
  }
  return enriched;
}

export function assertTestProcessStatus(
  result: TestProcessResult,
  expectedStatus = 0,
  description = "Test process exited unexpectedly"
): void {
  assert.strictEqual(
    result.status,
    expectedStatus,
    testProcessDiagnostic(result, `${description}; expected status ${expectedStatus}`)
  );
}

export function testProcessDiagnostic(result: TestProcessResult, summary: string): string {
  const invocation = [result.command, ...result.arguments]
    .map(argument => JSON.stringify(argument))
    .join(" ");
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const error = result.error
    ? `${result.error.name}: ${result.error.message}${errorCode ? ` (${errorCode})` : ""}`
    : "none";
  return [
    summary,
    `command: ${invocation}`,
    `timeout: ${result.timeoutMs}ms`,
    `status: ${String(result.status)}`,
    `signal: ${String(result.signal)}`,
    `error: ${error}`,
    "stdout:",
    formatOutput(result.stdout),
    "stderr:",
    formatOutput(result.stderr)
  ].join("\n");
}

function formatOutput(output: string | null | undefined): string {
  return output && output.length > 0 ? output : "<empty>";
}
