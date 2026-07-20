import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runRsglWorkerTask,
  type RsglWorkerCancellationToken,
  type RsglWorkerTaskOptions,
  type RsglWorkerTransport
} from "../../rsgl/host/commands/buildWorkerClient";
import {
  RsglBuildWorkerExitError,
  RsglCopySourceReadError,
  RsglOutputFileReadError,
  RsglUnsafeOutputPathError
} from "../../rsgl/host/commands/buildUiErrors";
import { serializeRsglWorkerFailure } from "../../rsgl/host/commands/buildWorkerFailure";
import { defaultRsglBuildPreviewMessages } from "../../../packages/rsgl-core/src/build";
import type {
  RsglWorkerRequestEnvelope,
  RsglWorkerResponse
} from "../../rsgl/host/commands/buildWorkerProtocol";

const testStdlibRoot = path.join(process.cwd(), "packages", "rsgl-core", "src", "stdlib", "rsgl");

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
          stdlibRoot: testStdlibRoot,
          source: { kind: "file", path: entry },
          validationAnchor: entry,
          outputRoot
        }
      }, workerOptions());

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
        payload: { sourceRoot, validationAnchor: sourceRoot, stdlibRoot: testStdlibRoot }
      }, workerOptions());

      assert.strictEqual(outcome.type, "success");
      if (outcome.type === "success") {
        assert.strictEqual(outcome.result.success, true);
        assert.strictEqual(outcome.result.emittedFiles.length, 3);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes a serializable localized preview dictionary through the worker", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-worker-preview-");
    const entry = path.join(root, "main.rsgl");

    try {
      fs.writeFileSync(entry, [
        "text texts/end {",
        "  content \"Hello PLAYERNAME\"",
        "}"
      ].join("\n"));

      const outcome = await runRsglWorkerTask({
        kind: "previewBuild",
        payload: {
          stdlibRoot: testStdlibRoot,
          source: { kind: "file", path: entry },
          validationAnchor: entry,
          outputRoot: path.join(root, "pack"),
          previewMessages: {
            ...defaultRsglBuildPreviewMessages,
            title: "本地化构建预览",
            entry: "入口：{0}"
          }
        }
      }, workerOptions());

      assert.strictEqual(outcome.type, "success");
      if (outcome.type === "success") {
        assert.match(outcome.result.preview ?? "", /^# 本地化构建预览$/m);
        assert.match(outcome.result.preview ?? "", /^入口：/m);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a known preview write-plan failure across the real worker boundary", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-worker-preview-error-");
    const entry = path.join(root, "main.rsgl");
    const outputRoot = path.join(root, "pack");
    const unreadableOutput = path.join(outputRoot, "assets", "minecraft", "texts", "end.txt");

    try {
      fs.writeFileSync(entry, [
        "text texts/end {",
        "  content \"Hello PLAYERNAME\"",
        "}"
      ].join("\n"));
      fs.mkdirSync(unreadableOutput, { recursive: true });

      await assert.rejects(() => runRsglWorkerTask({
        kind: "previewBuild",
        payload: {
          stdlibRoot: testStdlibRoot,
          source: { kind: "file", path: entry },
          validationAnchor: entry,
          outputRoot
        }
      }, workerOptions()), error =>
        error instanceof RsglOutputFileReadError && error.fileName === unreadableOutput
      );
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
          stdlibRoot: testStdlibRoot,
          sourceRoot,
          validationAnchor: sourceRoot,
          namespace: "worker_ns",
          defaultNamespace: "project_ns",
          projectTarget: { edition: "java", packFormat: { major: 75, minor: 0 } },
          maxEvaluationItems: 4321,
          maxItemModelDepth: 64
        }
      }, workerOptions());
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
          stdlibRoot: testStdlibRoot,
          sourceRoot,
          validationAnchor: sourceRoot,
          defaultNamespace: "worker_ns",
          projectTarget: { edition: "java", packFormat: { major: 74, minor: 0 } }
        }
      }, workerOptions());
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
    const promise = runRsglWorkerTask(compileRequest(), workerOptions({
      createTransport: () => {
        created = true;
        return transport;
      }
    }));

    assert.strictEqual(created, false);
    assert.strictEqual(transport.messages.length, 0);

    await nextTurn();
    assert.strictEqual(created, true);
    assert.strictEqual(transport.messages.length, 1);
    assert.strictEqual(transport.messages[0].request.payload.maxItemModelDepth, 64);

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
    const promise = runRsglWorkerTask(compileRequest(), workerOptions({
      cancellationToken: cancellation,
      createTransport: () => transport
    }));

    await nextTurn();
    cancellation.cancel();

    assert.deepStrictEqual(await promise, { type: "cancelled" });
    assert.strictEqual(transport.terminateCalls, 1);
  });

  it("does not start a queued worker after cancellation", async () => {
    const cancellation = new TestCancellationToken();
    let created = false;
    const promise = runRsglWorkerTask(compileRequest(), workerOptions({
      cancellationToken: cancellation,
      createTransport: () => {
        created = true;
        return new FakeWorkerTransport();
      }
    }));

    cancellation.cancel();

    assert.deepStrictEqual(await promise, { type: "cancelled" });
    await nextTurn();
    assert.strictEqual(created, false);
  });

  it("reports a structured error when the worker exits before responding", async () => {
    const transport = new FakeWorkerTransport();
    const promise = runRsglWorkerTask(compileRequest(), workerOptions({
      createTransport: () => transport
    }));

    await nextTurn();
    transport.emitExit(17);

    await assert.rejects(promise, error =>
      error instanceof RsglBuildWorkerExitError && error.exitCode === 17
    );
  });

  it("round-trips stable worker failure codes and preserves unknown technical details", async () => {
    await assertWorkerFailureRoundTrip(
      new RsglCopySourceReadError("C:\\sources\\pack.png"),
      error => error instanceof RsglCopySourceReadError && error.copyFrom === "C:\\sources\\pack.png"
    );
    await assertWorkerFailureRoundTrip(
      new RsglOutputFileReadError("C:\\pack\\generated.json"),
      error => error instanceof RsglOutputFileReadError && error.fileName === "C:\\pack\\generated.json"
    );
    await assertWorkerFailureRoundTrip(
      new RsglUnsafeOutputPathError("../escape.json"),
      error => error instanceof RsglUnsafeOutputPathError && error.outputPath === "../escape.json"
    );
    await assertWorkerFailureRoundTrip(
      new Error("technical worker detail"),
      error => error instanceof Error && error.message === "technical worker detail"
    );
  });
});

async function assertWorkerFailureRoundTrip(
  error: Error,
  validate: (error: unknown) => boolean
): Promise<void> {
  const transport = new FakeWorkerTransport();
  const promise = runRsglWorkerTask(compileRequest(), workerOptions({
    createTransport: () => transport
  }));

  await nextTurn();
  const failure = serializeRsglWorkerFailure(error);
  assert.ok(failure.args.length > 0);
  transport.emitMessage(failure);

  await assert.rejects(promise, validate);
}

function compileRequest() {
  return {
    kind: "compileDirectory" as const,
    payload: {
      stdlibRoot: testStdlibRoot,
      sourceRoot: "rsgl-src",
      validationAnchor: "rsgl-src",
      maxItemModelDepth: 64
    }
  };
}

function workerOptions(overrides: Partial<RsglWorkerTaskOptions> = {}): RsglWorkerTaskOptions {
  return {
    workerPath: path.join(process.cwd(), "out", "src", "rsgl", "host", "commands", "buildWorker.js"),
    ...overrides
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

  emitExit(code: number): void {
    this.exitListener?.(code);
  }
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
