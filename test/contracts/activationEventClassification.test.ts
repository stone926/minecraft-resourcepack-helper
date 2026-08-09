import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";

interface ClassificationModule {
  isRsglModuleLoadEvent(event: Record<string, unknown>): boolean;
  isRsglScanEvent(event: Record<string, unknown>): boolean;
}

interface DeferredModuleLoadRecorder {
  record(
    request: unknown,
    parent: unknown,
    isMain: boolean,
    durationMilliseconds?: number
  ): void;
  finalize(): ReadonlyArray<Record<string, unknown>>;
  readonly pendingCount: number;
}

interface DeferredModuleLoadsModule {
  createDeferredModuleLoadRecorder(options: {
    resolveFilename?(
      request: unknown,
      parent: unknown,
      isMain: boolean
    ): unknown;
    createEvent(
      rawEvent: Record<string, unknown>,
      resolved: unknown
    ): Record<string, unknown>;
  }): DeferredModuleLoadRecorder;
  createExtensionHostModuleLoadEvent(
    rawEvent: Record<string, unknown>,
    resolved: unknown,
    options: {
      sanitize(value: unknown): string | undefined;
      classify?(event: Record<string, unknown>): boolean;
    }
  ): Record<string, unknown>;
}

interface RedactionModule {
  redactActivationPaths(
    value: string,
    replacements: ReadonlyArray<readonly [string, string]>,
    platform?: string
  ): string;
}

describe("activation event classification", () => {
  const repositoryRoot = path.resolve(__dirname, "../../..");
  const requireFromTest = createRequire(__filename);
  const classification = requireFromTest(
    path.join(repositoryRoot, "scripts", "activation-probe", "event-classification.cjs")
  ) as ClassificationModule;
  const deferredModuleLoads = requireFromTest(
    path.join(repositoryRoot, "scripts", "activation-probe", "deferred-module-loads.cjs")
  ) as DeferredModuleLoadsModule;
  const redaction = requireFromTest(
    path.join(repositoryRoot, "scripts", "activation-probe", "path-redaction.cjs")
  ) as RedactionModule;

  it("detects default, recursive, caller-owned, and explicit RSGL scans", () => {
    assert.strictEqual(classification.isRsglScanEvent({ target: "<workspace>/rsgl" }), true);
    assert.strictEqual(classification.isRsglScanEvent({
      target: "<workspace>",
      recursive: true
    }), true);
    assert.strictEqual(classification.isRsglScanEvent({
      target: "<workspace>/custom-source",
      caller: "<extension>/bundle/features/rsglHost.js"
    }), true);
    assert.strictEqual(classification.isRsglScanEvent({ target: "**/*.rsgl" }), true);
    assert.strictEqual(classification.isRsglScanEvent({
      target: "<workspace>/assets",
      recursive: true,
      caller: "<extension>/bundle/extension.js"
    }), false);
  });

  it("redacts Windows extension roots without depending on path casing", () => {
    const value = "Error at e:/vscode/PROJECT/bundle/extension.js:10:2";
    assert.strictEqual(redaction.redactActivationPaths(value, [
      ["E:\\VSCode\\Project", "<extension>"]
    ], "win32"), "Error at <extension>/bundle/extension.js:10:2");
    assert.strictEqual(redaction.redactActivationPaths(value, [
      ["E:\\VSCode\\Project", "<extension>"]
    ], "linux"), value);
  });

  it("retains raw resolution inputs without resolving or serializing until finalization", () => {
    const phases: string[] = [];
    const request = "./feature";
    const parent = {
      id: "extension",
      filename: "C:\\extension\\bundle\\extension.js",
      path: "C:\\extension\\bundle",
      paths: ["C:\\extension\\node_modules"]
    };
    const recorder = deferredModuleLoads.createDeferredModuleLoadRecorder({
      resolveFilename(...actualArguments) {
        assert.strictEqual(actualArguments.length, 3);
        const [actualRequest, actualParent, isMain] = actualArguments;
        phases.push("resolve");
        assert.strictEqual(actualRequest, request);
        assert.notStrictEqual(actualParent, parent);
        assert.deepStrictEqual(actualParent, {
          id: "extension",
          filename: "C:\\extension\\bundle\\extension.js",
          path: "C:\\extension\\bundle",
          paths: ["C:\\extension\\node_modules"]
        });
        assert.strictEqual(isMain, false);
        return "C:\\extension\\bundle\\feature.js";
      },
      createEvent(rawEvent, resolved) {
        phases.push("serialize");
        assert.strictEqual(rawEvent.request, request);
        assert.deepStrictEqual(rawEvent.parent, {
          id: "extension",
          filename: "C:\\extension\\bundle\\extension.js",
          path: "C:\\extension\\bundle",
          paths: ["C:\\extension\\node_modules"]
        });
        assert.strictEqual("moduleReference" in rawEvent, false);
        assert.strictEqual(rawEvent.durationMilliseconds, 4.25);
        return { resolved };
      }
    });

    recorder.record(request, parent, false, 4.25);
    parent.filename = "C:\\mutated\\extension.js";
    parent.paths.push("C:\\mutated\\node_modules");
    assert.strictEqual(recorder.pendingCount, 1);
    assert.deepStrictEqual(phases, []);

    const events = recorder.finalize();
    assert.deepStrictEqual(phases, ["resolve", "serialize"]);
    assert.strictEqual(recorder.pendingCount, 0);
    assert.deepStrictEqual(events, [{ resolved: "C:\\extension\\bundle\\feature.js" }]);
    assert.strictEqual(recorder.finalize(), events, "finalization should be idempotent");
  });

  it("preserves resolved-path RSGL classification after deferred redaction", () => {
    let sanitizeCalls = 0;
    const sanitize = (value: unknown): string | undefined => {
      sanitizeCalls += 1;
      return redaction.redactActivationPaths(value as string, [
        ["C:\\extension", "<extension>"]
      ], "win32");
    };
    const recorder = deferredModuleLoads.createDeferredModuleLoadRecorder({
      resolveFilename(request) {
        return request === "./runtime-entry"
          ? "C:\\extension\\bundle\\features\\rsglHost.js"
          : request;
      },
      createEvent: (rawEvent, resolved) =>
        deferredModuleLoads.createExtensionHostModuleLoadEvent(
          rawEvent,
          resolved,
          { sanitize }
        )
    });
    const parent = { filename: "C:\\extension\\bundle\\extension.js" };
    recorder.record("./runtime-entry", parent, false, 7.5);
    recorder.record("node:path", parent, false, 0.25);
    assert.strictEqual(sanitizeCalls, 0, "redaction must remain outside the timed load path");

    const events = recorder.finalize();
    assert.strictEqual(sanitizeCalls, 6);
    assert.deepStrictEqual(events, [
      {
        request: "./runtime-entry",
        resolved: "<extension>/bundle/features/rsglHost.js",
        parent: "<extension>/bundle/extension.js",
        durationMilliseconds: 7.5,
        rsgl: true
      },
      {
        request: "node:path",
        resolved: "node:path",
        parent: "<extension>/bundle/extension.js",
        durationMilliseconds: 0.25,
        rsgl: false
      }
    ]);
    for (const event of events) {
      assert.strictEqual(
        event.rsgl,
        classification.isRsglModuleLoadEvent(event),
        "deferred events must keep the canonical report classification"
      );
    }
  });
});
