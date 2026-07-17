#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const [vsixArgument] = process.argv.slice(2);
if (!vsixArgument) {
  fail("Usage: node scripts/verify-rsgl-vsix.mjs <path-to-rsgl.vsix>");
}

const vsixPath = path.resolve(vsixArgument);
if (!existsSync(vsixPath)) {
  fail(`RSGL VSIX does not exist: ${vsixPath}`);
}

const extractionRoot = mkdtempSync(path.join(tmpdir(), "rsgl-vsix-smoke-"));
try {
  extractVsix(vsixPath, extractionRoot);
  await verifyLanguageServer(path.join(extractionRoot, "extension"));
  console.log(`RSGL VSIX runtime smoke passed: ${vsixPath}`);
} finally {
  rmSync(extractionRoot, { recursive: true, force: true });
}

function extractVsix(fileName, destination) {
  const invocation = process.platform === "win32"
    ? { file: "tar", args: ["-xf", fileName, "-C", destination] }
    : { file: "unzip", args: ["-q", fileName, "-d", destination] };
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    fail([
      `Unable to extract RSGL VSIX with ${invocation.file}.`,
      result.error?.message,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
}

async function verifyLanguageServer(extensionRoot) {
  const serverModule = path.join(
    extensionRoot,
    "bundle",
    "server.js",
  );
  if (!existsSync(serverModule)) {
    fail(`RSGL VSIX is missing its language server entry point: ${serverModule}`);
  }

  const child = spawn(process.execPath, [serverModule, "--stdio"], {
    cwd: extensionRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const protocol = createProtocolReader(child);

  try {
    const initializeResponse = protocol.waitForResponse(1);
    child.stdin.write(frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri: null,
        capabilities: {},
        initializationOptions: {},
      },
    }));
    const initializeResult = assertSuccessfulResponse(await initializeResponse, 1);
    if (!initializeResult?.capabilities) {
      fail("RSGL language server initialize response did not include capabilities.");
    }

    child.stdin.write(frame({ jsonrpc: "2.0", method: "initialized", params: {} }));
    const shutdownResponse = protocol.waitForResponse(2);
    child.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null }));
    assertSuccessfulResponse(await shutdownResponse, 2);

    child.stdin.end(frame({ jsonrpc: "2.0", method: "exit", params: null }));
    const exit = await protocol.waitForExit();
    if (exit.code !== 0) {
      fail(`RSGL language server exited with code ${exit.code}.\n${exit.stderr}`);
    }
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
  }
}

function createProtocolReader(child) {
  let buffer = Buffer.alloc(0);
  let stderr = "";
  let exitResult = null;
  let terminalError = null;
  const responses = new Map();
  const waiters = new Map();
  const exitWaiters = [];

  child.stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    readMessages();
  });
  child.stderr.on("data", chunk => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", error => finishWithError(error));
  child.on("exit", (code, signal) => {
    exitResult = { code, signal, stderr };
    for (const resolve of exitWaiters.splice(0)) {
      resolve(exitResult);
    }
    if (code !== 0) {
      finishWithError(new Error(`Language server exited with code ${code}.\n${stderr}`));
    }
  });

  return {
    waitForResponse(id) {
      if (responses.has(id)) {
        return Promise.resolve(responses.get(id));
      }
      if (terminalError) {
        return Promise.reject(terminalError);
      }
      return withTimeout(new Promise((resolve, reject) => {
        waiters.set(id, { resolve, reject });
      }), `Timed out waiting for LSP response ${id}.`);
    },
    waitForExit() {
      if (exitResult) {
        return Promise.resolve(exitResult);
      }
      return withTimeout(new Promise(resolve => exitWaiters.push(resolve)), "Timed out waiting for the RSGL language server to exit.");
    },
  };

  function readMessages() {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        finishWithError(new Error(`Invalid LSP response header: ${header}`));
        return;
      }
      const contentLength = Number(lengthMatch[1]);
      const messageEnd = headerEnd + 4 + contentLength;
      if (buffer.length < messageEnd) {
        return;
      }
      const payload = buffer.subarray(headerEnd + 4, messageEnd).toString("utf8");
      buffer = buffer.subarray(messageEnd);
      let message;
      try {
        message = JSON.parse(payload);
      } catch (error) {
        finishWithError(error);
        return;
      }
      if (message.id === undefined) {
        continue;
      }
      responses.set(message.id, message);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    }
  }

  function finishWithError(error) {
    terminalError = error instanceof Error ? error : new Error(String(error));
    for (const waiter of waiters.values()) {
      waiter.reject(terminalError);
    }
    waiters.clear();
  }
}

function frame(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function assertSuccessfulResponse(message, id) {
  if (message?.error) {
    fail(`RSGL language server returned an error for request ${id}: ${JSON.stringify(message.error)}`);
  }
  return message?.result;
}

function withTimeout(promise, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function fail(message) {
  throw new Error(message);
}
