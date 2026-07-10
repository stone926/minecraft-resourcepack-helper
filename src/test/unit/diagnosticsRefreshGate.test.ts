import * as assert from "node:assert";
import { DiagnosticsRefreshGate } from "../../diagnostics/diagnosticsRefreshGate";

describe("diagnostics refresh gate", () => {
  it("allows only the newest refresh for a URI", () => {
    const gate = new DiagnosticsRefreshGate();
    const first = gate.begin("file:///pack/model.json", 1);
    const second = gate.begin("file:///pack/model.json", 1);

    assert.strictEqual(gate.isCurrent(first, 1, false), false);
    assert.strictEqual(gate.isCurrent(second, 1, false), true);
  });

  it("rejects refreshes after version changes, closure, or explicit clearing", () => {
    const gate = new DiagnosticsRefreshGate();
    const versioned = gate.begin("file:///pack/model.json", 1);
    assert.strictEqual(gate.isCurrent(versioned, 2, false), false);
    assert.strictEqual(gate.isCurrent(versioned, 1, true), false);

    gate.clear(versioned.uriKey);
    assert.strictEqual(gate.isCurrent(versioned, 1, false), false);
  });

  it("invalidates every pending refresh when disposed", () => {
    const gate = new DiagnosticsRefreshGate();
    const first = gate.begin("file:///pack/first.json", 1);
    const second = gate.begin("file:///pack/second.json", 1);

    gate.clearAll();

    assert.strictEqual(gate.isCurrent(first, 1, false), false);
    assert.strictEqual(gate.isCurrent(second, 1, false), false);
  });
});
