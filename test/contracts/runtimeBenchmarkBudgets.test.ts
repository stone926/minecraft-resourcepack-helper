import * as assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface RuntimeBudgetsModule {
  evaluateModelPreviewBenchmark(output: string, budgets: unknown): unknown;
  evaluateRsglBenchmark(output: string, budgets: unknown): unknown;
  evaluateResourceUniverseBenchmark(report: unknown, budgets: unknown): unknown;
}

describe("runtime benchmark budgets", () => {
  let verifier: RuntimeBudgetsModule;

  before(async () => {
    verifier = await import(pathToFileURL(path.join(
      process.cwd(),
      "scripts",
      "verify-runtime-benchmarks.mjs"
    )).href) as RuntimeBudgetsModule;
  });

  it("parses model-preview metrics and rejects missing or over-budget fixtures", () => {
    const output = [
      "fixture,first_ir_ms,hot_refresh_ms",
      "simple,12.5,3.25",
      "artifact,raw_bytes,gzip_bytes",
      "model-preview-production,1000,400"
    ].join("\n");
    const budgets = { simple: { firstIr: 20, hotRefresh: 5 } };
    assert.doesNotThrow(() => verifier.evaluateModelPreviewBenchmark(output, budgets));
    assert.throws(
      () => verifier.evaluateModelPreviewBenchmark(output, {
        simple: { firstIr: 10, hotRefresh: 5 }
      }),
      /simple first IR exceeded its runtime budget: 12\.5 > 10/
    );
    assert.throws(
      () => verifier.evaluateModelPreviewBenchmark(output, {
        simple: { firstIr: 20, hotRefresh: 5 },
        parent: { firstIr: 20, hotRefresh: 5 }
      }),
      /fixtures differ from configured budgets/
    );
  });

  it("binds every RSGL smoke scenario to a numeric p95 budget", () => {
    const output = [
      "scenario,profile,work_items,input_bytes,iterations,outputs,diagnostics,source_mappings,min_ms,median_ms,p95_ms",
      "parse,smoke,1,2,1,1,0,0,1,2,3"
    ].join("\n");
    assert.deepStrictEqual(verifier.evaluateRsglBenchmark(output, { parse: 4 }), { parse: 3 });
    assert.throws(
      () => verifier.evaluateRsglBenchmark(output, { parse: 2 }),
      /parse p95 exceeded its runtime budget/
    );
  });

  it("rejects incomplete resource-universe reports and metric drift", () => {
    const report = {
      schemaVersion: 1,
      status: "completed",
      command: { profile: "smoke" },
      scenarios: [{
        id: "scan",
        status: "measured",
        measurements: { scanMilliseconds: { p95: 9 } }
      }]
    };
    assert.deepStrictEqual(
      verifier.evaluateResourceUniverseBenchmark(report, {
        scan: { scanMilliseconds: 10 }
      }),
      { scan: { scanMilliseconds: 9 } }
    );
    assert.throws(
      () => verifier.evaluateResourceUniverseBenchmark(report, {
        scan: { scanMilliseconds: 8 }
      }),
      /scan scanMilliseconds p95 exceeded its runtime budget/
    );
    assert.throws(
      () => verifier.evaluateResourceUniverseBenchmark(report, {
        scan: { renamedMetric: 10 }
      }),
      /scan metrics differ from configured budgets/
    );
  });
});
