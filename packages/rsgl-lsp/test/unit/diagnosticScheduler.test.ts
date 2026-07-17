import * as assert from "node:assert";
import { DirtyDiagnosticScheduler } from "../../src/diagnosticScheduler";

describe("RSGL dirty diagnostic scheduler", () => {
  it("deduplicates dirty documents in one generation", async () => {
    const runs: string[] = [];
    const scheduler = new DirtyDiagnosticScheduler<string>({
      run: uri => { runs.push(uri); },
      yieldControl: async () => undefined
    });

    scheduler.schedule(["a", "a", "b"]);
    await scheduler.flush();

    assert.deepStrictEqual(runs, ["a", "b"]);
    scheduler.dispose();
  });

  it("requeues entries that have not started when a newer generation arrives", async () => {
    const runs: Array<{ uri: string; generation: number }> = [];
    const scheduler = new DirtyDiagnosticScheduler<string>({
      run: (uri, generation) => {
        runs.push({ uri, generation });
        if (uri === "a") {
          scheduler.schedule(["c"], 0);
        }
      },
      yieldControl: async () => undefined
    });

    scheduler.schedule(["a", "b"]);
    await scheduler.flush();
    await scheduler.flush();

    assert.deepStrictEqual(runs.map(run => run.uri), ["a", "c", "b"]);
    assert.ok(runs[1].generation > runs[0].generation);
    assert.strictEqual(runs[1].generation, runs[2].generation);
    scheduler.dispose();
  });

  it("drops closed documents before validation begins", async () => {
    const runs: string[] = [];
    const scheduler = new DirtyDiagnosticScheduler<string>({
      run: uri => { runs.push(uri); },
      yieldControl: async () => undefined
    });
    scheduler.schedule(["closed"]);
    scheduler.drop("closed");

    await scheduler.flush();

    assert.deepStrictEqual(runs, []);
    scheduler.dispose();
  });

  it("runs one verification generation when validation discovers new dependencies", async () => {
    const runs: Array<{ uri: string; generation: number }> = [];
    let dependencyGraphExpanded = true;
    const scheduler = new DirtyDiagnosticScheduler<string>({
      run: (uri, generation) => {
        runs.push({ uri, generation });
        if (dependencyGraphExpanded) {
          dependencyGraphExpanded = false;
          scheduler.schedule([uri], 0);
        }
      },
      yieldControl: async () => undefined
    });

    scheduler.schedule(["file:///main.rsgl"]);
    await scheduler.flush();
    await scheduler.flush();

    assert.deepStrictEqual(runs.map(run => run.uri), [
      "file:///main.rsgl",
      "file:///main.rsgl"
    ]);
    assert.ok(runs[1].generation > runs[0].generation);
    scheduler.dispose();
  });
});
