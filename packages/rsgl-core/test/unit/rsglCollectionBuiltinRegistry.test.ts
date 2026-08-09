import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  collectionBuiltinDescriptors,
  collectionBuiltinNamesForLayer,
  jsonResourceFragmentBuiltinDescriptors
} from "../../src/builtinRegistry";
import { builtinRsglCompletions } from "../../src/completionData";
import {
  evaluateCollectionBuiltin,
  isCollectionRuntimeBuiltinName,
  type CollectionBuiltinHost
} from "../../src/compiler/collectionBuiltins";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule, formatType } from "../../src/semantic";
import {
  createBuiltinSymbols,
  getBuiltinSignature
} from "../../src/semantic/builtins";
import { isCollectionBuiltinName } from "../../src/semantic/collectionBuiltinInference";

describe("RSGL collection builtin registry", () => {
  it("declares handler keys exactly matching the declared layers", () => {
    const seen = new Set<string>();
    for (const descriptor of collectionBuiltinDescriptors) {
      assert.strictEqual(seen.has(descriptor.name), false, `Duplicate builtin '${descriptor.name}'.`);
      seen.add(descriptor.name);
      assert.strictEqual(
        descriptor.infer !== undefined,
        (descriptor.layers as readonly string[]).includes("infer"),
        `'${descriptor.name}' must declare an infer handler iff it joins the infer layer.`
      );
      assert.strictEqual(
        descriptor.eval !== undefined,
        (descriptor.layers as readonly string[]).includes("eval"),
        `'${descriptor.name}' must declare an eval handler iff it joins the eval layer.`
      );
      assert.ok(descriptor.completion.label, `Missing completion label for '${descriptor.name}'.`);
      assert.ok(descriptor.completion.detail, `Missing completion detail for '${descriptor.name}'.`);
    }
  });

  it("drives the semantic inference name set from the registry", () => {
    const inferNames = collectionBuiltinNamesForLayer("infer");
    assert.deepStrictEqual(
      [...inferNames].sort(),
      ["asList", "concat", "entries", "filter", "flat", "flatMap", "has", "join", "keys", "length", "map", "mergeObjects", "product", "values"]
    );
    for (const descriptor of collectionBuiltinDescriptors) {
      assert.strictEqual(
        isCollectionBuiltinName(descriptor.name),
        (descriptor.layers as readonly string[]).includes("infer"),
        `Semantic inference routing for '${descriptor.name}' disagrees with the registry.`
      );
    }
    for (const name of ["seq", "glob", "startsWith", "replace", "padStart", "yaw", "pad"]) {
      assert.strictEqual(isCollectionBuiltinName(name), false, `'${name}' is not a collection builtin.`);
    }
  });

  it("drives the runtime evaluation name set from the registry", () => {
    const evalNames = collectionBuiltinNamesForLayer("eval");
    assert.deepStrictEqual(
      [...evalNames].sort(),
      ["asList", "concat", "entries", "filter", "flat", "flatMap", "join", "keys", "length", "map", "mergeObjects", "product", "values"]
    );
    for (const descriptor of collectionBuiltinDescriptors) {
      assert.strictEqual(
        isCollectionRuntimeBuiltinName(descriptor.name),
        (descriptor.layers as readonly string[]).includes("eval"),
        `Runtime evaluation routing for '${descriptor.name}' disagrees with the registry.`
      );
    }
  });

  it("keeps has as an infer-only scalar predicate outside the collection runtime path", () => {
    const descriptor = collectionBuiltinDescriptors.find(candidate => candidate.name === "has");
    assert.deepStrictEqual(descriptor?.layers, ["infer"]);

    // The compiler inlines has in callEvaluation.ts with the scalar predicates;
    // the collection evaluation path must refuse it.
    const host = {
      budget: { tryConsume: () => true, canConsume: () => true, remaining: 0, consumed: 0, limit: 0 },
      isLambda: () => false,
      invokeLambda: () => ({ value: undefined }),
      reportError: () => undefined,
      markFailure: () => undefined
    } as unknown as CollectionBuiltinHost;
    assert.deepStrictEqual(
      evaluateCollectionBuiltin("has", [], { start: 0, end: 0 }, host),
      { handled: false }
    );
  });

  it("derives builtin symbol signatures from the registry", () => {
    const symbols = new Map(createBuiltinSymbols().map(symbol => [symbol.name, symbol]));
    for (const descriptor of collectionBuiltinDescriptors) {
      const symbol = symbols.get(descriptor.name);
      assert.ok(symbol, `Missing builtin symbol '${descriptor.name}'.`);
      assert.strictEqual(symbol.kind, "builtin");
      assert.strictEqual(symbol.effect, descriptor.effect);
      assert.deepStrictEqual(
        getBuiltinSignature(descriptor.name),
        descriptor.signature,
        `Installed signature for '${descriptor.name}' does not match the registry.`
      );
    }
  });

  it("derives collection completion entries from the registry, including product", () => {
    for (const descriptor of collectionBuiltinDescriptors) {
      const candidate = builtinRsglCompletions.find(item => item.label === descriptor.completion.label);
      assert.ok(candidate, `Missing completion entry for '${descriptor.name}'.`);
      assert.strictEqual(candidate.kind, "function");
      assert.strictEqual(candidate.insertText, descriptor.completion.insertText);
      assert.strictEqual(candidate.detail, descriptor.completion.detail);
    }
    const product = builtinRsglCompletions.find(item => item.label === "product");
    assert.ok(product, "product must have a completion entry.");
    assert.ok(product.insertText?.includes("product("));
  });

  it("derives sugar fragment completion entries from the registry", () => {
    for (const descriptor of jsonResourceFragmentBuiltinDescriptors) {
      const candidate = builtinRsglCompletions.find(item => item.label === descriptor.completion.label);
      assert.ok(candidate, `Missing completion entry for sugar builtin '${descriptor.name}'.`);
      assert.strictEqual(candidate.insertText, descriptor.completion.insertText);
      assert.strictEqual(candidate.detail, descriptor.completion.detail);
    }
  });

  it("infers product rows through the collection inference path", () => {
    const model = bindRsglModule(parseRsgl([
      "let combos = product({ size: [1, 2], wood: [\"oak\"] })",
      "let invalid = product({ size: [1], bad: true })"
    ].join("\n")));

    assert.deepStrictEqual(
      model.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.productSourceNotIterable"]
    );
    const combos = model.scope.symbols.get("combos")?.type;
    assert.strictEqual(combos?.kind, "List");
    assert.strictEqual(combos?.elementType?.kind, "Object");
    assert.deepStrictEqual(
      Array.from(combos?.elementType?.properties?.keys() ?? []),
      ["size", "wood"]
    );
    const size = combos?.elementType?.properties?.get("size")?.type;
    const wood = combos?.elementType?.properties?.get("wood")?.type;
    assert.ok(size && wood);
    assert.strictEqual(formatType(size), "1 | 2");
    assert.strictEqual(formatType(wood), "\"oak\"");
  });

  it("routes inference, evaluation, and fragments through registry-driven handler tables", () => {
    const inferenceSource = readSource("packages", "rsgl-core", "src", "semantic", "collectionBuiltinInference.ts");
    const evaluationSource = readSource("packages", "rsgl-core", "src", "compiler", "collectionBuiltins.ts");
    const fragmentsSource = readSource("packages", "rsgl-core", "src", "compiler", "jsonResourceFragments.ts");
    const completionSource = readSource("packages", "rsgl-core", "src", "completionData.ts");
    const symbolsSource = readSource("packages", "rsgl-core", "src", "semantic", "builtins.ts");

    assert.ok(inferenceSource.includes("collectionInferenceHandlers[handlerKey]"));
    assert.ok(inferenceSource.includes("satisfies Record<RsglCollectionInferHandler, CollectionInferenceHandler>"));
    assert.ok(evaluationSource.includes("collectionEvaluationHandlers[handlerKey]"));
    assert.ok(evaluationSource.includes("satisfies Record<RsglCollectionEvalHandler, CollectionBuiltinEvaluator>"));
    assert.ok(fragmentsSource.includes("jsonResourceFragmentHandlers[descriptor.handler]"));
    assert.ok(fragmentsSource.includes("getJsonResourceFragmentBuiltinDescriptor(kind, call.callee.name.text)"));
    assert.ok(completionSource.includes("collectionBuiltinDescriptors.map"));
    assert.ok(completionSource.includes("jsonResourceFragmentBuiltinDescriptors.map"));
    assert.ok(symbolsSource.includes("collectionBuiltinDescriptors.map"));
    for (const descriptor of collectionBuiltinDescriptors) {
      assert.strictEqual(
        completionSource.includes(`label: "${descriptor.name}"`),
        false,
        `completionData.ts must not hand-write the '${descriptor.name}' entry.`
      );
    }
  });
});

function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), ...segments), "utf8");
}
