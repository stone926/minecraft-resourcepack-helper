import * as assert from "node:assert/strict";
import { shouldReportMissingResource } from "../../diagnostics/resourceDiagnosticResolution";

describe("resource diagnostic resolution", () => {
  it("reports only authoritative misses", () => {
    assert.strictEqual(shouldReportMissingResource({ resolved: false, coverage: "authoritative" }), true);
    assert.strictEqual(shouldReportMissingResource({ resolved: false, coverage: "partial" }), false);
    assert.strictEqual(shouldReportMissingResource({ resolved: false, coverage: "unavailable" }), false);
  });

  it("never reports a resolved resource as missing", () => {
    for (const coverage of ["authoritative", "partial", "unavailable"] as const) {
      assert.strictEqual(shouldReportMissingResource({ resolved: true, coverage }), false);
    }
  });
});
