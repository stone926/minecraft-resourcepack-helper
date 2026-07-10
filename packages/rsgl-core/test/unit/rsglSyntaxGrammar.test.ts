import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("RSGL TextMate merge grammar", () => {
  it("highlights base and merge vocabulary without retaining removed syntax", () => {
    const grammarPath = path.join(process.cwd(), "extensions", "vscode-rsgl", "syntaxes", "rsgl.tmLanguage.json");
    const grammarText = fs.readFileSync(grammarPath, "utf8");
    const grammar = JSON.parse(grammarText) as {
      repository?: { keywords?: { patterns?: Array<{ name?: string; match?: string }> } };
    };
    const patterns = grammar.repository?.keywords?.patterns ?? [];
    const controlPattern = patterns.find(pattern => pattern.name === "keyword.control.rsgl")?.match;
    assert.ok(controlPattern, "Expected a TextMate control-keyword pattern.");
    const controlKeywords = new RegExp(controlPattern);

    for (const keyword of ["base", "merge", "deep", "strict", "upsert", "append"]) {
      assert.ok(controlKeywords.test(keyword), `Expected '${keyword}' to use keyword.control.rsgl.`);
    }
    for (const removed of ["raw_json", "raw_json_file", "override"]) {
      assert.strictEqual(grammarText.includes(removed), false, `Removed syntax '${removed}' remains in the grammar.`);
    }
  });
});
