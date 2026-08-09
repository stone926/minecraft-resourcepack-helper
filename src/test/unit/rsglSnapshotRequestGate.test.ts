import * as assert from "node:assert";
import type { ResourcePackProjectContextDto } from "../../../packages/resource-project/src";
import type { RsglRuntimeInstance } from "../../rsgl/runtime";
import {
  RsglSnapshotRequestGate,
  type RsglSnapshotRequestGateHost
} from "../../rsgl/rsglSnapshotRequestGate";
import type { ResourceContributionRequest } from "../../resourceUniverse";

describe("RSGL snapshot request gate", () => {
  it("keeps untracked and disabled projects cold", async () => {
    const fixture = requestGateFixture();
    const signal = new AbortController().signal;

    const untracked = await fixture.gate.requestSnapshot(snapshotRequest(), signal) as {
      coverage: { reason: string };
    };
    assert.strictEqual(untracked.coverage.reason, "notProbed");
    assert.strictEqual(fixture.languageServerRequests, 0);

    fixture.gate.trackProject("project");
    fixture.disabled = true;
    const disabled = await fixture.gate.requestSnapshot(snapshotRequest(), signal) as {
      coverage: { reason: string };
    };
    assert.strictEqual(disabled.coverage.reason, "disabled");
    assert.strictEqual(fixture.languageServerRequests, 0);
  });

  it("tracks an active request until the runtime snapshot settles", async () => {
    const fixture = requestGateFixture();
    const runtimeReady = deferred<RsglRuntimeInstance | null>();
    fixture.ensureLanguageServer = () => runtimeReady.promise;
    fixture.gate.trackProject("project");

    const request = fixture.gate.requestSnapshot(
      snapshotRequest(),
      new AbortController().signal
    );
    await Promise.resolve();
    assert.strictEqual(fixture.gate.hasActiveSnapshotRequest("project"), true);

    runtimeReady.resolve({
      requestResourceSnapshot: async value => value,
      dispose: () => undefined
    });
    const response = await request as { projectContext: { projectId: string } };
    assert.strictEqual(response.projectContext.projectId, "project");
    assert.strictEqual(fixture.gate.hasActiveSnapshotRequest("project"), false);
  });

  it("coalesces hydration and remembers only the newest 256 transactions", async () => {
    const fixture = requestGateFixture();
    const hydrationRelease = deferred<void>();
    let hydrations = 0;
    const hydrate = async (): Promise<void> => {
      hydrations++;
      await hydrationRelease.promise;
    };
    const commit = (): void => undefined;

    const first = fixture.gate.ensureHydrated("project", "context-r1", hydrate, commit);
    const second = fixture.gate.ensureHydrated("project", "context-r1", hydrate, commit);
    assert.strictEqual(first, second);
    await Promise.resolve();
    assert.strictEqual(hydrations, 1);
    hydrationRelease.resolve();
    await first;
    await fixture.gate.ensureHydrated("project", "context-r1", hydrate, commit);
    assert.strictEqual(hydrations, 1);

    for (let index = 0; index <= 256; index++) {
      fixture.gate.rememberMaterializationTransaction(`transaction-${index}`);
    }
    assert.strictEqual(fixture.gate.hasMaterializationTransaction("transaction-0"), false);
    assert.strictEqual(fixture.gate.hasMaterializationTransaction("transaction-1"), true);
    assert.strictEqual(fixture.gate.hasMaterializationTransaction("transaction-256"), true);
  });

  it("clears a rejected hydration flight so the same revision can retry", async () => {
    const fixture = requestGateFixture();
    let attempts = 0;
    const hydrate = async (): Promise<void> => {
      attempts++;
      if (attempts === 1) {
        throw new Error("synthetic hydration failure");
      }
    };

    await assert.rejects(
      fixture.gate.ensureHydrated("project", "context-r1", hydrate, () => undefined),
      /synthetic hydration failure/
    );
    await fixture.gate.ensureHydrated("project", "context-r1", hydrate, () => undefined);
    assert.strictEqual(attempts, 2);
  });

  it("retires forgotten hydration without publishing stale state or leaving idle early", async () => {
    const fixture = requestGateFixture();
    const staleRelease = deferred<string>();
    const commits: string[] = [];
    fixture.gate.trackProject("project");
    const stale = fixture.gate.ensureHydrated(
      "project",
      "context-r1",
      () => staleRelease.promise,
      value => { commits.push(value); }
    );
    await Promise.resolve();

    fixture.gate.forgetProject("project");
    let idle = false;
    const idlePromise = fixture.gate.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    assert.strictEqual(idle, false);

    fixture.gate.trackProject("project");
    let replacementLoads = 0;
    const replacement = fixture.gate.ensureHydrated(
      "project",
      "context-r1",
      async () => {
        replacementLoads++;
        return "fresh";
      },
      value => { commits.push(value); }
    );
    await replacement;
    assert.deepStrictEqual(commits, ["fresh"]);
    assert.strictEqual(idle, false, "the retired flight must remain inside the idle boundary");

    staleRelease.resolve("stale");
    await stale;
    await idlePromise;
    assert.deepStrictEqual(commits, ["fresh"]);
    await fixture.gate.ensureHydrated(
      "project",
      "context-r1",
      async () => {
        replacementLoads++;
        return "unexpected";
      },
      value => { commits.push(value); }
    );
    assert.strictEqual(replacementLoads, 1);
  });

  it("lets a committed materialization supersede an older initial hydration", async () => {
    const fixture = requestGateFixture();
    const staleRelease = deferred<string>();
    const commits: string[] = [];
    const stale = fixture.gate.ensureHydrated(
      "project",
      "context-r1",
      () => staleRelease.promise,
      value => { commits.push(value); }
    );
    await Promise.resolve();

    fixture.gate.markHydrated("project", "context-r2");
    staleRelease.resolve("stale");
    await stale;
    assert.strictEqual(commits.length, 0);

    let reloads = 0;
    await fixture.gate.ensureHydrated(
      "project",
      "context-r2",
      async () => {
        reloads++;
        return "unexpected";
      },
      value => { commits.push(value); }
    );
    assert.strictEqual(reloads, 0);
    assert.deepStrictEqual(commits, []);
  });

  it("includes tracked materialization applications in the idle boundary", async () => {
    const fixture = requestGateFixture();
    const applicationRelease = deferred<boolean>();
    const application = fixture.gate.trackMaterializationApplication(
      "transaction-active",
      applicationRelease.promise
    );
    let idle = false;
    const idlePromise = fixture.gate.whenIdle().then(() => {
      idle = true;
    });

    await Promise.resolve();
    assert.strictEqual(idle, false);
    assert.strictEqual(
      fixture.gate.hasMaterializationTransaction("transaction-active"),
      true
    );
    applicationRelease.resolve(true);
    assert.strictEqual(await application, true);
    await idlePromise;
    assert.strictEqual(idle, true);
    assert.strictEqual(
      fixture.gate.hasMaterializationTransaction("transaction-active"),
      false,
      "a failed or uncommitted application remains retryable after it settles"
    );
  });
});

function requestGateFixture(): {
  gate: RsglSnapshotRequestGate;
  disabled: boolean;
  languageServerRequests: number;
  ensureLanguageServer: () => Promise<RsglRuntimeInstance | null>;
} {
  const fixture = {
    disabled: false,
    languageServerRequests: 0,
    ensureLanguageServer: async (): Promise<RsglRuntimeInstance | null> => ({
      requestResourceSnapshot: async value => value,
      dispose: () => undefined
    })
  };
  const host: RsglSnapshotRequestGateHost = {
    getProjectContext: projectId => projectId === "project" ? projectContext() : undefined,
    isRuntimeDisabled: () => fixture.disabled,
    ensureLanguageServer: async () => {
      fixture.languageServerRequests++;
      return fixture.ensureLanguageServer();
    },
    getRuntimeUnavailableReason: () => "notProbed",
    getLanguageServerFailureReason: () => "lspFailed",
    getLastKnownRevision: () => "snapshot-r1"
  };
  return Object.assign(fixture, { gate: new RsglSnapshotRequestGate(host) });
}

function snapshotRequest(): ResourceContributionRequest {
  return {
    projectId: "project",
    scope: { projectId: "project" },
    requestGeneration: 1
  };
}

function projectContext(): ResourcePackProjectContextDto {
  return {
    projectId: "project",
    workspaceFolderUri: "file:///workspace",
    projectRootUri: "file:///workspace/pack",
    packRootUri: "file:///workspace/pack",
    assetsRootUri: "file:///workspace/pack/assets",
    rsglSourceRootUris: ["file:///workspace/pack/rsgl"],
    outputPackRootUri: "file:///workspace/pack",
    outputAssetsRootUri: "file:///workspace/pack/assets",
    localLayer: {
      layerId: "local",
      role: "local",
      source: "directory",
      rootUri: "file:///workspace/pack",
      priority: 0,
      metadataRevision: "metadata-r1"
    },
    externalLayers: [],
    overlaySelection: [],
    configurationRevision: "configuration-r1",
    contextRevision: "context-r1"
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
