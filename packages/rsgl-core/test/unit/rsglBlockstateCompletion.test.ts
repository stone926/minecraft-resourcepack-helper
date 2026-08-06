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
    for (const expected of ["variant entry", "default variant", "random", "let", "use", "for", "for object", "if", "base", "merge", "custom"]) {
      assert.ok(variants.has(expected), `Expected variants root completion '${expected}'.`);
    }
    assert.strictEqual(variants.has("apply"), false);
    assert.strictEqual(variants.has("when"), false);
    assert.strictEqual(variants.has("variants"), false);
    assert.strictEqual(variants.has("multipart"), false);
    const multipart = syntaxLabelsAtEnd("blockstate multipart wall {\n  ");
    for (const expected of ["part when", "part always", "random", "let", "use", "for", "for object", "if", "base", "merge", "custom"]) {
      assert.ok(multipart.has(expected), `Expected multipart root completion '${expected}'.`);
    }
    assert.strictEqual(multipart.has("variant entry"), false);

    const afterEntry = syntaxLabelsAtEnd([
      "blockstate variants stone {",
      "  case * => minecraft:block/stone",
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
      "default variant",
      "random",
      "let",
      "use",
      "for",
      "for indexed",
      "for object",
      "for multidim",
      "if"
    ]);

    const multipart = syntaxLabelsAtEnd("template parts() -> multipart {\n  ");
    assert.deepStrictEqual([...multipart], [
      "part when",
      "part when predicate",
      "part always",
      "random",
      "let",
      "use",
      "for",
      "for indexed",
      "for object",
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

  it("emits only canonical case, part, ModelSpec, and random snippets", () => {
    const variants = candidatesAtEnd("template states() -> variants {\n  ");
    const variantEntry = variants.find(candidate => candidate.label === "variant entry")?.insertText ?? "";
    const variantRandom = variants.find(candidate => candidate.label === "random")?.insertText ?? "";
    assert.match(variantEntry, /^case \{.*\} => .*minecraft:block\/stone/);
    assert.doesNotMatch(variantEntry, /->|@|\{\s*model\s*:|\bweight=/);
    assert.match(variantRandom, /^case \{.*\} => random \{/);
    assert.match(variantRandom, /option .* weight /);
    assert.doesNotMatch(variantRandom, /@|\{\s*model\s*:/);

    const multipart = candidatesAtEnd("template parts() -> multipart {\n  ");
    const stateRecord = multipart.find(candidate => candidate.label === "part when")?.insertText ?? "";
    const predicate = multipart.find(candidate => candidate.label === "part when predicate")?.insertText ?? "";
    const apply = multipart.find(candidate => candidate.label === "part always")?.insertText ?? "";
    const random = multipart.find(candidate => candidate.label === "random")?.insertText ?? "";
    assert.match(stateRecord, /^part when \{.*\} =>/);
    assert.match(predicate, /^part when \$state\./);
    assert.match(apply, /^part always => .*minecraft:block\/stone/);
    assert.doesNotMatch(apply, /@|\{\s*model\s*:/);
    assert.match(random, /^part always => random \{/);
    assert.match(random, /option .* weight /);
    assert.doesNotMatch(random, /@|\{\s*model\s*:/);
  });

  it("offers only option-producing constructs inside choice bodies", () => {
    const templateChoice = syntaxLabelsAtEnd("template choices() -> choice {\n  ");
    assert.deepStrictEqual([...templateChoice], [
      "option",
      "weighted option",
      "let",
      "use",
      "for",
      "for indexed",
      "for object",
      "for multidim",
      "if"
    ]);

    const randomChoice = syntaxLabelsAtEnd("blockstate variants stone {\n  case * => random {\n    ");
    assert.ok(randomChoice.has("option"));
    assert.ok(randomChoice.has("for"));
    assert.strictEqual(randomChoice.has("variant entry"), false);
    assert.strictEqual(randomChoice.has("part always"), false);
    assert.strictEqual(randomChoice.has("merge"), false);
  });

  it("offers only canonical fields at ModelSpec with-object key positions", () => {
    const direct = [
      "blockstate variants stone {",
      "  case * => minecraft:block/stone with {",
      "    "
    ].join("\n");
    assert.strictEqual(
      getRsglCompletionContext(direct, direct.length).blockstateModelOptions,
      true
    );
    assert.deepStrictEqual([...syntaxLabelsAtEnd(direct)], ["x", "y", "z", "uvlock"]);

    const randomOption = [
      "blockstate multipart wall {",
      "  part always => random {",
      "    option minecraft:block/side with { uv"
    ].join("\n");
    assert.strictEqual(
      getRsglCompletionContext(randomOption, randomOption.length).blockstateModelOptions,
      true
    );
    assert.deepStrictEqual([...syntaxLabelsAtEnd(randomOption)], ["x", "y", "z", "uvlock"]);

    const valuePosition = [
      "blockstate variants stone {",
      "  case * => minecraft:block/stone with { y: "
    ].join("\n");
    assert.strictEqual(
      getRsglCompletionContext(valuePosition, valuePosition.length).blockstateModelOptions,
      false
    );
  });

  it("offers the runtime state namespace while entering multipart predicates", () => {
    const predicate = [
      "blockstate multipart wall {",
      "  part when (",
      "    "
    ].join("\n");
    const context = getRsglCompletionContext(predicate, predicate.length);

    assert.strictEqual(context.blockstatePredicate, true);
    assert.deepStrictEqual([...syntaxLabelsAtEnd(predicate)], ["$state"]);
  });

  it("ends multipart predicate completion at either arrow during error recovery", () => {
    for (const arrow of ["=>", "->"]) {
      const source = [
        "blockstate multipart wall {",
        `  part when $state.powered ${arrow} minecraft:block/wall`,
        "  "
      ].join("\n");

      assert.strictEqual(getRsglCompletionContext(source, source.length).blockstatePredicate, false);
    }
  });
});
