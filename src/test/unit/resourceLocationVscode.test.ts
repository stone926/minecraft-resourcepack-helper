import { resolveFreshCompiledModule } from "../../../test/helpers/compiledHarness";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../../../test/helpers/testProcess";

describe("resource Location VS Code bridge", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("maps offsets, contains unreadable documents, observes cancellation, and de-duplicates", () => {
    const script = [
      "const assert = require('node:assert/strict');",
      "const Module = require('node:module'); const originalLoad = Module._load;",
      "class Position { constructor(line, character) { this.line = line; this.character = character; } }",
      "class Range { constructor(start, end) { this.start = start; this.end = end; } }",
      "class Location { constructor(uri, rangeOrPosition) { this.uri = uri; this.range = rangeOrPosition instanceof Position ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition; } }",
      "const Uri = { parse: value => ({ value, toString: () => value }) };",
      "const opened = []; let cancelOnOpen = false;",
      "const workspace = { openTextDocument: async uri => {",
      "  opened.push(uri.toString());",
      "  if (uri.toString().includes('unreadable')) throw new Error('offline');",
      "  if (cancelOnOpen) token.isCancellationRequested = true;",
      "  return { positionAt: offset => new Position(Math.floor(offset / 10), offset % 10) };",
      "} };",
      "Module._load = function(request, ...args) {",
      "  if (request === 'vscode') return { Location, Position, Range, Uri, workspace };",
      "  return originalLoad.call(this, request, ...args);",
      "};",
      "const bridge = require(process.argv[1]);",
      "let token = { isCancellationRequested: false };",
      "(async () => {",
      "  const start = await bridge.toVscodeLocation({ uri: 'file:///plain.json' }, token);",
      "  assert.deepStrictEqual(start.range, new Range(new Position(0, 0), new Position(0, 0)));",
      "  assert.deepStrictEqual(opened, []);",
      "  const ranged = await bridge.toVscodeLocation({ uri: 'file:///ranged.json', range: { start: 12, end: 25 } }, token);",
      "  assert.deepStrictEqual(ranged.range, new Range(new Position(1, 2), new Position(2, 5)));",
      "  const fallback = await bridge.toVscodeLocation({ uri: 'file:///unreadable.json', range: { start: 4, end: 8 } }, token);",
      "  assert.deepStrictEqual(fallback.range, new Range(new Position(0, 0), new Position(0, 0)));",
      "  token = { isCancellationRequested: false }; cancelOnOpen = true;",
      "  assert.strictEqual(await bridge.toVscodeLocation({ uri: 'file:///cancelled.json', range: { start: 1, end: 2 } }, token), undefined);",
      "  const duplicate = new Location(Uri.parse('file:///same.json'), new Range(new Position(3, 4), new Position(3, 8)));",
      "  const other = new Location(Uri.parse('file:///other.json'), new Position(0, 0));",
      "  const unique = bridge.uniqueVscodeLocations([duplicate, { ...duplicate }, other]);",
      "  assert.strictEqual(unique.length, 2);",
      "  assert.deepStrictEqual(unique.map(location => location.uri.toString()), ['file:///same.json', 'file:///other.json']);",
      "  assert.deepStrictEqual(unique[0].range, duplicate.range);",
      "})().catch(error => { console.error(error); process.exitCode = 1; });"
    ].join("\n");
    const sourcePath = resolveFreshCompiledModule("src/utils/resourceLocationVscode.ts");
    const result = runTestProcessSync(process.execPath, ["-e", script, sourcePath]);
    assertTestProcessStatus(result);
  });
});
