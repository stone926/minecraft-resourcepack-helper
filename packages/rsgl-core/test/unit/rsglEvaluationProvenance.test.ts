import * as assert from "node:assert";
import {
  deduplicatePathEntries,
  deduplicateValueIssues,
  originForEvaluationPath
} from "../../src/compiler/evaluationProvenance";
import type { EvaluationValueIssue } from "../../src/compiler/evaluationTypes";

describe("RSGL evaluation provenance", () => {
  it("copies empty and single-entry provenance inputs without changing their values", () => {
    const empty: Array<{ generatedPath: string; value: string }> = [];
    const single = [{ generatedPath: "/value", value: "only" }];

    const deduplicatedEmpty = deduplicatePathEntries(empty);
    const deduplicatedSingle = deduplicatePathEntries(single);

    assert.deepStrictEqual(deduplicatedEmpty, []);
    assert.notStrictEqual(deduplicatedEmpty, empty);
    assert.deepStrictEqual(deduplicatedSingle, single);
    assert.notStrictEqual(deduplicatedSingle, single);
  });

  it("retains the last path observation in first-path insertion order", () => {
    const result = deduplicatePathEntries([
      { generatedPath: "/shared", value: "first" },
      { generatedPath: "/other", value: "other" },
      { generatedPath: "/shared", value: "last" }
    ]);

    assert.deepStrictEqual(result, [
      { generatedPath: "/shared", value: "last" },
      { generatedPath: "/other", value: "other" }
    ]);
  });

  it("copies short issue inputs and retains the last identical issue", () => {
    const empty: EvaluationValueIssue[] = [];
    const single: EvaluationValueIssue[] = [{
      generatedPath: "/value",
      kind: "undefined",
      sourceFile: "single.rsgl",
      sourceRange: { start: 1, end: 2 }
    }];
    const first: EvaluationValueIssue = {
      generatedPath: "/value",
      kind: "undefined",
      sourceFile: "same.rsgl",
      sourceRange: { start: 3, end: 4 }
    };
    const last: EvaluationValueIssue = { ...first };

    const deduplicatedEmpty = deduplicateValueIssues(empty);
    const deduplicatedSingle = deduplicateValueIssues(single);
    const deduplicatedIssues = deduplicateValueIssues([first, last]);

    assert.deepStrictEqual(deduplicatedEmpty, []);
    assert.notStrictEqual(deduplicatedEmpty, empty);
    assert.deepStrictEqual(deduplicatedSingle, single);
    assert.notStrictEqual(deduplicatedSingle, single);
    assert.deepStrictEqual(deduplicatedIssues, [last]);
    assert.strictEqual(deduplicatedIssues[0], last);
  });

  it("selects the first most-specific matching path without crossing segment boundaries", () => {
    const origins = [
      { generatedPath: "", sourceFile: "root.rsgl", sourceRange: { start: 0, end: 1 } },
      { generatedPath: "/foo", sourceFile: "foo.rsgl", sourceRange: { start: 1, end: 2 } },
      { generatedPath: "/foo/bar", sourceFile: "first.rsgl", sourceRange: { start: 2, end: 3 } },
      { generatedPath: "/foo/bar", sourceFile: "second.rsgl", sourceRange: { start: 3, end: 4 } }
    ];

    assert.deepStrictEqual(originForEvaluationPath(origins, "/foo/bar/value"), {
      sourceFile: "first.rsgl",
      sourceRange: { start: 2, end: 3 }
    });
    assert.deepStrictEqual(originForEvaluationPath(origins, "/foobar/value"), {
      sourceFile: "root.rsgl",
      sourceRange: { start: 0, end: 1 }
    });
    assert.strictEqual(originForEvaluationPath(origins.slice(1), "/foobar/value"), undefined);
  });
});
