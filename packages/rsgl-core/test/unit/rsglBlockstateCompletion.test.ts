import * as assert from "node:assert";
import { getRsglCompletionContext } from "../../src/completionContext";
import {
  builtinRsglCompletions,
  getRsglCompletionCandidates
} from "../../src/completionData";

const builtinLabels = new Set(builtinRsglCompletions.map(candidate => candidate.label));

function candidatesAtEnd(text: string) {
  return getRsglCompletionCandidates(text, text.length);
}

function syntaxLabelsAtEnd(text: string): Set<string> {
  return new Set(
    candidatesAtEnd(text)
      .filter(candidate => !builtinLabels.has(candidate.label))
      .map(candidate => candidate.label)
  );
}

describe("RSGL blockstate completion", () => {
  it("distinguishes concrete, nested-root, and entry-template body contexts", () => {
    const variantsRoot = "blockstate variants stone {\n  ";
    assert.deepStrictEqual(getRsglCompletionContext(variantsRoot, variantsRoot.length).blockstate, {
      mode: "variants",
      scope: "concreteRoot"
    });
    assert.strictEqual(getRsglCompletionContext(variantsRoot, variantsRoot.length).allowBase, true);

    const multipartRoot = "blockstate multipart wall {\n  ";
    assert.deepStrictEqual(getRsglCompletionContext(multipartRoot, multipartRoot.length).blockstate, {
      mode: "multipart",
      scope: "concreteRoot"
    });

    const nestedRoot = [
      "blockstate variants stone {",
      "  for facing in HORIZONTAL {",
      "    "
    ].join("\n");
    assert.deepStrictEqual(getRsglCompletionContext(nestedRoot, nestedRoot.length).blockstate, {
      mode: "variants",
      scope: "nestedRoot"
    });
    assert.strictEqual(getRsglCompletionContext(nestedRoot, nestedRoot.length).allowBase, false);

    const nestedConditionalRoot = [
      "blockstate multipart wall {",
      "  if enabled {",
      "    "
    ].join("\n");
    assert.deepStrictEqual(
      getRsglCompletionContext(nestedConditionalRoot, nestedConditionalRoot.length).blockstate,
      { mode: "multipart", scope: "nestedRoot" }
    );

    const entryTemplate = [
      "template states() -> variants {",
      "  for facing in HORIZONTAL {",
      "    "
    ].join("\n");
    assert.deepStrictEqual(getRsglCompletionContext(entryTemplate, entryTemplate.length).blockstate, {
      mode: "variants",
      scope: "entryTemplate"
    });
    assert.strictEqual(getRsglCompletionContext(entryTemplate, entryTemplate.length).allowBase, false);
  });

  it("offers only explicit blockstate modes at top level", () => {
    const blockstateCandidates = candidatesAtEnd("").filter(candidate => candidate.label.startsWith("blockstate"));
    assert.deepStrictEqual(blockstateCandidates.map(candidate => candidate.label), [
      "blockstate variants",
      "blockstate multipart"
    ]);
    assert.ok(blockstateCandidates[0]?.insertText?.startsWith("blockstate variants ${1:id} {"));
    assert.ok(blockstateCandidates[1]?.insertText?.startsWith("blockstate multipart ${1:id} {"));
  });

  it("offers mode entries plus root operations in concrete blockstates", () => {
    const variants = syntaxLabelsAtEnd("blockstate variants stone {\n  ");
    for (const expected of ["variant entry", "random", "let", "use", "for", "if", "base", "merge", "custom"]) {
      assert.ok(variants.has(expected), `Expected variants root completion '${expected}'.`);
    }
    assert.strictEqual(variants.has("apply"), false);
    assert.strictEqual(variants.has("when"), false);
    assert.strictEqual(variants.has("variants"), false);
    assert.strictEqual(variants.has("multipart"), false);
    const multipart = syntaxLabelsAtEnd("blockstate multipart wall {\n  ");
    for (const expected of ["when", "apply", "random", "let", "use", "for", "if", "base", "merge", "custom"]) {
      assert.ok(multipart.has(expected), `Expected multipart root completion '${expected}'.`);
    }
    assert.strictEqual(multipart.has("variant entry"), false);

    const afterEntry = syntaxLabelsAtEnd([
      "blockstate variants stone {",
      "  {}: minecraft:block/stone",
      "  "
    ].join("\n"));
    assert.strictEqual(afterEntry.has("base"), false);
    assert.ok(afterEntry.has("merge"));
    assert.ok(afterEntry.has("custom"));
  });

  it("keeps nested roots root-capable but removes base", () => {
    const nested = syntaxLabelsAtEnd([
      "blockstate variants stone {",
      "  if enabled {",
      "    "
    ].join("\n"));
    assert.ok(nested.has("variant entry"));
    assert.ok(nested.has("merge"));
    assert.ok(nested.has("custom"));
    assert.strictEqual(nested.has("base"), false);
  });

  it("keeps explicit body templates entry-only", () => {
    const variants = syntaxLabelsAtEnd("template states() -> variants {\n  ");
    assert.deepStrictEqual([...variants], [
      "variant entry",
      "random",
      "let",
      "use",
      "for",
      "for multidim",
      "if"
    ]);

    const multipart = syntaxLabelsAtEnd("template parts() -> multipart {\n  ");
    assert.deepStrictEqual([...multipart], [
      "when",
      "apply",
      "random",
      "let",
      "use",
      "for",
      "for multidim",
      "if"
    ]);
    for (const labels of [variants, multipart]) {
      assert.strictEqual(labels.has("base"), false);
      assert.strictEqual(labels.has("merge"), false);
      assert.strictEqual(labels.has("custom"), false);
      assert.strictEqual(labels.has("element"), false);
    }
  });

  it("emits only canonical variant, apply, and random snippets", () => {
    const variants = candidatesAtEnd("template states() -> variants {\n  ");
    const variantEntry = variants.find(candidate => candidate.label === "variant entry")?.insertText ?? "";
    const variantRandom = variants.find(candidate => candidate.label === "random")?.insertText ?? "";
    assert.match(variantEntry, /\}: .*minecraft:block\/stone/);
    assert.doesNotMatch(variantEntry, /->|@|\{\s*model\s*:/);
    assert.match(variantRandom, /\}: random \[/);
    assert.match(variantRandom, /weight=/);
    assert.doesNotMatch(variantRandom, /@|\{\s*model\s*:/);

    const multipart = candidatesAtEnd("template parts() -> multipart {\n  ");
    const apply = multipart.find(candidate => candidate.label === "apply")?.insertText ?? "";
    const random = multipart.find(candidate => candidate.label === "random")?.insertText ?? "";
    assert.match(apply, /^apply .*minecraft:block\/stone/);
    assert.doesNotMatch(apply, /@|\{\s*model\s*:/);
    assert.match(random, /^apply random \[/);
    assert.match(random, /weight=/);
    assert.doesNotMatch(random, /@|\{\s*model\s*:/);
  });
});
