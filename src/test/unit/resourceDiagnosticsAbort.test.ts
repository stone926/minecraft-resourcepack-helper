import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

describe("resource diagnostics abort handling", () => {
  it("silently abandons cancelled refreshes while preserving later refreshes and real failures", () => {
    const script = [
      "const assert = require('node:assert');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "class Position { constructor(line, character) { this.line = line; this.character = character; } }",
      "class Range { constructor(start, end) { this.start = start; this.end = end; } }",
      "class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }",
      "const vscode = { Position, Range, Diagnostic, DiagnosticSeverity: { Warning: 1 } };",
      "const reference = { value: 'demo:block/target', valueNode: {} };",
      "Module._load = function(request, parent, ...args) {",
      "  if (request === 'vscode') return vscode;",
      "  if (parent?.filename === process.argv[1]) {",
      "    if (request === '../i18n/messages') return { lm: value => value };",
      "    if (request === '../i18n/runtime') return { localize: value => value };",
      "    if (request === '../utils/pathGenerator') return { createResourceReferencePathResolver: () => () => null };",
      "    if (request === '../utils/resourceReferences') return { getResourceReferences: () => [reference], isResourceReferenceDocument: () => true };",
      "    if (request === '../utils/resourceRange') return { rangeInsideString: () => null };",
      "    if (request === '../cit/citDiagnostics') return { getCitDiagnostics: () => [] };",
      "    if (request === './semanticDiagnostics') return { getSemanticResourceDiagnostics: async () => [] };",
      "    if (request === './semanticDiagnosticsCore') return { isSemanticDiagnosticsDocument: () => false };",
      "    if (request === './resourceDiagnosticResolution') return { shouldReportMissingResource: () => false };",
      "  }",
      "  return originalLoad.call(this, request, parent, ...args);",
      "};",
      "const { refreshResourceDiagnostics } = require(process.argv[1]);",
      "const uri = { toString: () => 'file:///pack/assets/demo/models/block/consumer.json' };",
      "const document = { uri, fileName: '/pack/assets/demo/models/block/consumer.json', languageId: 'json', version: 1, isClosed: false, getText: () => '{}' };",
      "const collection = { setCalls: [], delete() {}, set(target, diagnostics) { this.setCalls.push({ target, diagnostics }); } };",
      "const nativeAbort = new DOMException('This operation was aborted', 'AbortError');",
      "const structuralAbort = { name: 'AbortError' };",
      "const wrappedAbort = new Error('snapshot request failed', { cause: structuralAbort });",
      "(async () => {",
      "  for (const abort of [nativeAbort, structuralAbort, wrappedAbort]) {",
      "    const setsBeforeAbort = collection.setCalls.length;",
      "    await refreshResourceDiagnostics(document, collection, async () => { throw abort; });",
      "    assert.strictEqual(collection.setCalls.length, setsBeforeAbort, 'a cancelled refresh must not publish diagnostics');",
      "    document.version++;",
      "    await refreshResourceDiagnostics(document, collection, async () => ({ targetUri: uri, coverage: 'authoritative' }));",
      "    assert.strictEqual(collection.setCalls.length, setsBeforeAbort + 1, 'the next refresh must still publish');",
      "    assert.strictEqual(collection.setCalls.at(-1).target, uri);",
      "    assert.deepStrictEqual(collection.setCalls.at(-1).diagnostics, []);",
      "  }",
      "  const expected = new Error('real resolver failure');",
      "  await assert.rejects(",
      "    refreshResourceDiagnostics(document, collection, async () => { throw expected; }),",
      "    error => error === expected",
      "  );",
      "  assert.strictEqual(collection.setCalls.length, 3, 'a real failure must not publish partial diagnostics');",
      "})().catch(error => { process.stderr.write(`${error?.stack ?? error}\\n`); process.exitCode = 1; });"
    ].join("\n");
    const diagnosticsPath = path.join(
      process.cwd(),
      "out",
      "src",
      "diagnostics",
      "resourceDiagnostics.js"
    );

    const result = spawnSync(process.execPath, ["-e", script, diagnosticsPath], { encoding: "utf8" });

    assert.strictEqual(result.status, 0, String(result.stderr));
  });
});
