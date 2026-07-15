import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  runRsglWorkerTask,
  type RsglWorkerCancellationToken,
  type RsglWorkerTransport
} from "../../../../extensions/vscode-rsgl/src/commands/buildWorkerClient";
import type {
  RsglWorkerRequestEnvelope,
  RsglWorkerResponse
} from "../../../../extensions/vscode-rsgl/src/commands/buildWorkerProtocol";
import { createTempDir } from "./helpers/fs";

describe("RSGL build worker client", () => {
  it("prepares a build in a real worker without writing output", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-worker-");
    const entry = path.join(root, "main.rsgl");
    const outputRoot = path.join(root, "pack");

    try {
      fs.writeFileSync(entry, [
        "text texts/end {",
        "  content \"Hello PLAYERNAME\"",
        "}"
      ].join("\n"));

      const outcome = await runRsglWorkerTask({
        kind: "prepareBuild",
        payload: {
          source: { kind: "file", path: entry },
          validationAnchor: entry,
          outputRoot
        }
      });

      assert.strictEqual(outcome.type, "success");
      if (outcome.type === "success") {
        assert.strictEqual(outcome.result.diagnostics.length, 0);
        assert.strictEqual(outcome.result.files?.length, 3);
      }
      assert.strictEqual(fs.existsSync(outputRoot), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("compiles watcher directories in a real worker", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-worker-watch-");
    const sourceRoot = path.join(root, "src");

    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "main.rsgl"), [
        "text texts/end {",
        "  content \"Hello PLAYERNAME\"",
        "}"
      ].join("\n"));

      const outcome = await runRsglWorkerTask({
        kind: "compileDirectory",
        payload: { sourceRoot, validationAnchor: sourceRoot }
      });

      assert.strictEqual(outcome.type, "success");
      if (outcome.type === "success") {
        assert.strictEqual(outcome.result.success, true);
        assert.strictEqual(outcome.result.emittedFiles.length, 3);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the serialized project namespace and target snapshot in the worker", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-worker-config-路径-");
    const sourceRoot = path.join(root, "source files");

    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "main.rsgl"), [
        "model block rotated {}",
        "blockstate variants rotated {",
        "  case * => block/rotated with { z: 90 }",
        "}"
      ].join("\n"));

      const modern = await runRsglWorkerTask({
        kind: "compileDirectory",
        payload: {
          sourceRoot,
          validationAnchor: sourceRoot,
          namespace: "worker_ns",
          defaultNamespace: "project_ns",
          projectTarget: { edition: "java", packFormat: { major: 75, minor: 0 } },
          maxEvaluationItems: 4321
        }
      });
      assert.strictEqual(modern.type, "success");
      if (modern.type === "success") {
        assert.strictEqual(modern.result.success, true);
        assert.ok(modern.result.emittedFiles.some(file =>
          file.outputPath.replaceAll("\\", "/") === "assets/worker_ns/models/block/rotated.json"
        ));
      }

      const olderTarget = await runRsglWorkerTask({
        kind: "compileDirectory",
        payload: {
          sourceRoot,
          validationAnchor: sourceRoot,
          defaultNamespace: "worker_ns",
          projectTarget: { edition: "java", packFormat: { major: 74, minor: 0 } }
        }
      });
      assert.strictEqual(olderTarget.type, "success");
      if (olderTarget.type === "success") {
        assert.strictEqual(olderTarget.result.success, false);
        assert.ok(olderTarget.result.diagnostics.some(diagnostic =>
          diagnostic.code === "rsgl.unsupportedBlockstateZRotation"
        ));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not create or invoke the worker in the caller's synchronous stack", async () => {
    const transport = new FakeWorkerTransport();
    let created = false;
    const promise = runRsglWorkerTask(compileRequest(), undefined, () => {
      created = true;
      return transport;
    });

    assert.strictEqual(created, false);
    assert.strictEqual(transport.messages.length, 0);

    await nextTurn();
    assert.strictEqual(created, true);
    assert.strictEqual(transport.messages.length, 1);

    transport.emitMessage({
      type: "success",
      kind: "compileDirectory",
      result: { success: true, diagnostics: [], dependencies: [], emittedFiles: [] }
    });
    const outcome = await promise;
    assert.strictEqual(outcome.type, "success");
  });

  it("terminates an active worker when cancellation is requested", async () => {
    const transport = new FakeWorkerTransport();
    const cancellation = new TestCancellationToken();
    const promise = runRsglWorkerTask(compileRequest(), cancellation, () => transport);

    await nextTurn();
    cancellation.cancel();

    assert.deepStrictEqual(await promise, { type: "cancelled" });
    assert.strictEqual(transport.terminateCalls, 1);
  });

  it("does not start a queued worker after cancellation", async () => {
    const cancellation = new TestCancellationToken();
    let created = false;
    const promise = runRsglWorkerTask(compileRequest(), cancellation, () => {
      created = true;
      return new FakeWorkerTransport();
    });

    cancellation.cancel();

    assert.deepStrictEqual(await promise, { type: "cancelled" });
    await nextTurn();
    assert.strictEqual(created, false);
  });
});

function compileRequest() {
  return {
    kind: "compileDirectory" as const,
    payload: {
      sourceRoot: "rsgl-src",
      validationAnchor: "rsgl-src"
    }
  };
}

class TestCancellationToken implements RsglWorkerCancellationToken {
  private readonly listeners = new Set<() => void>();
  public isCancellationRequested = false;

  onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

class FakeWorkerTransport implements RsglWorkerTransport {
  public readonly messages: RsglWorkerRequestEnvelope[] = [];
  public terminateCalls = 0;
  private messageListener: ((response: RsglWorkerResponse) => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;
  private exitListener: ((code: number) => void) | null = null;

  postMessage(message: RsglWorkerRequestEnvelope): void {
    this.messages.push(message);
  }

  onceMessage(listener: (response: RsglWorkerResponse) => void): void {
    this.messageListener = listener;
  }

  onceError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  onceExit(listener: (code: number) => void): void {
    this.exitListener = listener;
  }

  removeAllListeners(): void {
    this.messageListener = null;
    this.errorListener = null;
    this.exitListener = null;
  }

  async terminate(): Promise<number> {
    this.terminateCalls++;
    return 0;
  }

  emitMessage(response: RsglWorkerResponse): void {
    this.messageListener?.(response);
  }
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
