import * as assert from "node:assert";
import { RsglRuntimeController, type RsglRuntimeInstance } from "../../rsgl/runtime";

describe("RsglRuntimeController", () => {
  it("single-flights concurrent host and language-server requests", async () => {
    const gate = deferred<RsglRuntimeInstance>();
    let loads = 0;
    let languageServerStarts = 0;
    const controller = new RsglRuntimeController(async () => {
      loads += 1;
      return gate.promise;
    }, { mode: "auto", hasActiveProject: true });

    const open = controller.ensureLoaded("openDocument");
    const command = controller.ensureLanguageServer("command");
    assert.strictEqual(loads, 1);
    gate.resolve(runtime({
      ensureLanguageServer: async () => { languageServerStarts += 1; }
    }));

    const [openRuntime, commandRuntime] = await Promise.all([open, command]);
    assert.strictEqual(openRuntime, commandRuntime);
    assert.strictEqual(languageServerStarts, 1);
    assert.strictEqual(controller.getState().kind, "ready");
  });

  it("disposes a stale runtime that resolves after switching off", async () => {
    const gate = deferred<RsglRuntimeInstance>();
    let disposed = 0;
    const controller = new RsglRuntimeController(async request => {
      assert.strictEqual(request.signal.aborted, false);
      return gate.promise;
    }, { mode: "auto", hasActiveProject: true });

    const loading = controller.ensureLoaded("openDocument");
    const switchingOff = controller.setMode("off");
    gate.resolve(runtime({ dispose: async () => { disposed += 1; } }));
    assert.strictEqual(await loading, null);
    await switchingOff;

    assert.strictEqual(disposed, 1);
    assert.deepStrictEqual(controller.getState(), {
      kind: "suspended",
      generation: 2,
      reason: "disabled"
    });
  });

  it("does not load while cold-off and rechecks signals when enabled", async () => {
    let loads = 0;
    let rechecks = 0;
    const controller = new RsglRuntimeController(async () => {
      loads += 1;
      return runtime();
    }, {
      mode: "off",
      hasActiveProject: true,
      recheckSignals: () => { rechecks += 1; }
    });

    assert.strictEqual(await controller.ensureLoaded("openDocument"), null);
    assert.strictEqual(loads, 0);
    await controller.setMode("auto");
    assert.strictEqual(rechecks, 1);
    assert.strictEqual(loads, 0);
    assert.strictEqual(controller.getState().kind, "idle");
    await controller.ensureLoaded("visibleDocument");
    assert.strictEqual(loads, 1);
  });

  it("clears failed in-flight state and retries only when explicitly requested", async () => {
    let loads = 0;
    const controller = new RsglRuntimeController(async () => {
      loads += 1;
      if (loads === 1) {
        throw new Error("load failed");
      }
      return runtime();
    }, { mode: "auto", hasActiveProject: true });

    await assert.rejects(controller.ensureLoaded("openDocument"), /load failed/);
    assert.strictEqual(controller.getState().kind, "failed");
    assert.strictEqual(await controller.ensureLoaded("visibleDocument"), null);
    assert.strictEqual(loads, 1);
    assert.ok(await controller.retry("manualRefresh"));
    assert.strictEqual(loads, 2);
    assert.strictEqual(controller.getState().kind, "ready");
  });

  it("keeps one ready runtime across auto and on transitions", async () => {
    let loads = 0;
    let disposals = 0;
    let rechecks = 0;
    const controller = new RsglRuntimeController(async () => {
      loads += 1;
      return runtime({ dispose: () => { disposals += 1; } });
    }, {
      mode: "auto",
      hasActiveProject: true,
      recheckSignals: () => { rechecks += 1; }
    });

    await controller.ensureLoaded("openDocument");
    await controller.setMode("on");
    await controller.setMode("auto");

    assert.strictEqual(loads, 1);
    assert.strictEqual(disposals, 0);
    assert.strictEqual(rechecks, 2);
    assert.strictEqual(controller.getState().kind, "ready");
    await controller.dispose();
    assert.strictEqual(disposals, 1);
  });

  it("awaits async runtime shutdown and makes disposal terminal", async () => {
    const disposal = deferred<void>();
    let disposeCalls = 0;
    const controller = new RsglRuntimeController(async () => runtime({
      dispose: async () => {
        disposeCalls += 1;
        await disposal.promise;
      }
    }), { mode: "on", hasActiveProject: true });
    await controller.ensureLoaded("configuration");
    const terminalStates: string[] = [];
    controller.onDidChangeState(state => terminalStates.push(state.kind));

    let completed = false;
    const shutdown = controller.dispose().then(() => { completed = true; });
    await Promise.resolve();
    assert.strictEqual(completed, false);
    assert.strictEqual(controller.getState().kind, "disposed");
    assert.deepStrictEqual(terminalStates, ["disposed"]);
    assert.strictEqual(
      (controller as unknown as { listeners: { size: number } }).listeners.size,
      0,
      "terminal shutdown should release state listeners after the final event"
    );
    disposal.resolve();
    await shutdown;
    await controller.dispose();
    assert.strictEqual(disposeCalls, 1);
    assert.deepStrictEqual(terminalStates, ["disposed"]);
    assert.strictEqual(await controller.ensureLoaded("command"), null);
  });
});

function runtime(overrides: Partial<RsglRuntimeInstance> = {}): RsglRuntimeInstance {
  return {
    dispose: () => undefined,
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
