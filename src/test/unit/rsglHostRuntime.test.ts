import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runRsglWorkerTask,
  type RsglWorkerTransport
} from "../../rsgl/host/commands/buildWorkerClient";
import type {
  RsglWorkerRequestEnvelope,
  RsglWorkerResponse
} from "../../rsgl/host/commands/buildWorkerProtocol";
import { executeRsglWorkerTask } from "../../rsgl/host/commands/buildWorkerTask";

describe("integrated RSGL host runtime", () => {
  it("loads and creates the host factory without touching VS Code, the client, or build commands", () => {
    const hostRoot = path.join(process.cwd(), "out", "src", "rsgl", "host");
    const script = [
      "const assert = require('node:assert');",
      "const Module = require('node:module');",
      "const originalLoad = Module._load;",
      "Module._load = function(request, ...args) {",
      "  if (request === 'vscode' || request.startsWith('vscode-languageclient')) throw new Error(`eager ${request}`);",
      "  return originalLoad.call(this, request, ...args);",
      "};",
      "const host = require(process.argv[1]);",
      "const clientPath = require.resolve(process.argv[2]);",
      "const buildPath = require.resolve(process.argv[3]);",
      "const runtime = host.createRsglRuntime({",
      "  extensionContext: {},",
      "  serverPath: process.argv[4],",
      "  workerPath: process.argv[5],",
      "  stdlibRoot: process.argv[6]",
      "});",
      "assert.strictEqual(require.cache[clientPath], undefined);",
      "assert.strictEqual(require.cache[buildPath], undefined);",
      "runtime.dispose().then(() => {",
      "  assert.strictEqual(require.cache[clientPath], undefined);",
      "  assert.strictEqual(require.cache[buildPath], undefined);",
      "}).catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");
    const result = spawnSync(process.execPath, [
      "-e",
      script,
      path.join(hostRoot, "rsglHost.js"),
      path.join(hostRoot, "client.js"),
      path.join(hostRoot, "commands", "build.js"),
      path.join(hostRoot, "server.js"),
      path.join(hostRoot, "worker.js"),
      path.join(hostRoot, "stdlib")
    ], { encoding: "utf8" });

    assert.strictEqual(result.status, 0, result.stderr);
  });

  it("forwards snapshot requests and invalidations through the lazy host boundary", () => {
    const hostRoot = path.join(process.cwd(), "out", "src", "rsgl", "host");
    const script = [
      "const assert = require('node:assert');",
      "const hostPath = process.argv[1];",
      "const clientPath = require.resolve(process.argv[2]);",
      "let serverListener; let requestSignal; let disposed = 0;",
      "const resolveNavigation = async request => ({ echoedNavigation: request });",
      "require.cache[clientPath] = {",
      "  id: clientPath, filename: clientPath, loaded: true, children: [], paths: [],",
      "  exports: { startRsglLanguageServer: async options => {",
      "    assert.strictEqual(options.stdlibRoot, process.argv[5]);",
      "    assert.strictEqual(options.resolveResourceNavigation, resolveNavigation);",
      "    return {",
      "      refreshWorkspace: async () => undefined,",
      "      requestResourceSnapshot: async (request, signal) => { requestSignal = signal; return { echoed: request }; },",
      "      onResourceSnapshotInvalidated: listener => { serverListener = listener; return { dispose: () => { serverListener = undefined; } }; },",
      "      dispose: async () => { disposed++; }",
      "    };",
      "  } }",
      "};",
      "const runtime = require(hostPath).createRsglRuntime({ extensionContext: {}, serverPath: process.argv[3], workerPath: process.argv[4], stdlibRoot: process.argv[5], resolveResourceNavigation: resolveNavigation });",
      "let notifications = 0; const subscription = runtime.onResourceSnapshotInvalidated(value => { assert.strictEqual(value.projectId, 'project'); notifications++; });",
      "const abort = new AbortController();",
      "runtime.requestResourceSnapshot({ projectId: 'project' }, abort.signal).then(async response => {",
      "  assert.deepStrictEqual(response, { echoed: { projectId: 'project' } });",
      "  assert.strictEqual(requestSignal, abort.signal);",
      "  serverListener({ projectId: 'project' }); assert.strictEqual(notifications, 1);",
      "  subscription.dispose(); serverListener({ projectId: 'project' }); assert.strictEqual(notifications, 1);",
      "  await runtime.dispose(); assert.strictEqual(disposed, 1); assert.strictEqual(serverListener, undefined);",
      "}).catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");
    const result = spawnSync(process.execPath, [
      "-e",
      script,
      path.join(hostRoot, "rsglHost.js"),
      path.join(hostRoot, "client.js"),
      path.join(hostRoot, "server.js"),
      path.join(hostRoot, "worker.js"),
      path.join(hostRoot, "stdlib")
    ], { encoding: "utf8" });

    assert.strictEqual(result.status, 0, result.stderr);
  });

  it("passes the explicit worker path and awaits termination before completing a transaction", async () => {
    const transport = new DeferredTerminationTransport();
    let receivedWorkerPath = "";
    let completed = false;
    const promise = runRsglWorkerTask(compileRequest("C:\\runtime path\\stdlib"), {
      workerPath: "C:\\runtime path\\worker.js",
      createTransport: workerPath => {
        receivedWorkerPath = workerPath;
        return transport;
      }
    }).then(outcome => {
      completed = true;
      return outcome;
    });

    await nextTurn();
    assert.strictEqual(receivedWorkerPath, "C:\\runtime path\\worker.js");
    assert.strictEqual(transport.messages[0].request.payload.stdlibRoot, "C:\\runtime path\\stdlib");
    transport.emitMessage(successfulCompileResponse());
    await Promise.resolve();
    assert.strictEqual(completed, false, "the transaction must await worker termination");

    transport.completeTermination();
    assert.strictEqual((await promise).type, "success");
    assert.strictEqual(transport.terminateCalls, 1);
  });

  it("requires a worker path before queueing a transaction", () => {
    assert.throws(
      () => runRsglWorkerTask(compileRequest("stdlib"), { workerPath: "" }),
      /explicit non-empty path/
    );
  });

  it("carries stdlibRoot through the worker payload into compilation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-worker-stdlib-路径-"));
    const sourceRoot = path.join(root, "source files");
    const stdlibRoot = path.join(root, "installed stdlib");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(stdlibRoot, { recursive: true });
    fs.writeFileSync(path.join(stdlibRoot, "__worker_dynamic.rsgl"), [
      "template dynamicWorkerText(id: ResourceId) {",
      "  text id {",
      "    content \"from explicit stdlib\"",
      "  }",
      "}",
      "export { dynamicWorkerText }"
    ].join("\n"));
    fs.writeFileSync(path.join(sourceRoot, "main.rsgl"), [
      "import { dynamicWorkerText } from \"rsgl:__worker_dynamic.rsgl\"",
      "use dynamicWorkerText(texts/end)"
    ].join("\n"));

    try {
      const response = executeRsglWorkerTask({
        kind: "compileDirectory",
        payload: {
          sourceRoot,
          validationAnchor: sourceRoot,
          stdlibRoot
        }
      }, () => false);
      assert.strictEqual(response.type, "success");
      if (response.type === "success" && response.kind === "compileDirectory") {
        assert.strictEqual(response.result.success, true);
        assert.ok(response.result.emittedFiles.some(file =>
          file.outputPath.replaceAll("\\", "/") === "assets/minecraft/texts/end.txt"
        ));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function compileRequest(stdlibRoot: string) {
  return {
    kind: "compileDirectory" as const,
    payload: {
      sourceRoot: "rsgl-src",
      validationAnchor: "rsgl-src",
      stdlibRoot
    }
  };
}

function successfulCompileResponse(): RsglWorkerResponse<"compileDirectory"> {
  return {
    type: "success",
    kind: "compileDirectory",
    result: { success: true, diagnostics: [], dependencies: [], emittedFiles: [] }
  };
}

class DeferredTerminationTransport implements RsglWorkerTransport {
  public readonly messages: RsglWorkerRequestEnvelope[] = [];
  public terminateCalls = 0;
  private messageListener: ((response: RsglWorkerResponse) => void) | undefined;
  private terminationResolve: ((code: number) => void) | undefined;

  public postMessage(message: RsglWorkerRequestEnvelope): void {
    this.messages.push(message);
  }

  public onceMessage(listener: (response: RsglWorkerResponse) => void): void {
    this.messageListener = listener;
  }

  public onceError(listener: (error: Error) => void): void {
    void listener;
  }

  public onceExit(listener: (code: number) => void): void {
    void listener;
  }

  public removeAllListeners(): void { }

  public terminate(): Promise<number> {
    this.terminateCalls++;
    return new Promise(resolve => {
      this.terminationResolve = resolve;
    });
  }

  public emitMessage(response: RsglWorkerResponse): void {
    this.messageListener?.(response);
  }

  public completeTermination(): void {
    this.terminationResolve?.(0);
  }
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
