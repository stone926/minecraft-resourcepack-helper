import assert from "node:assert/strict";
import path from "node:path";

const profiles = Object.freeze({
  default: Object.freeze({
    warmupIterations: 1,
    measuredIterations: 5,
    semanticResources: 1_200,
    blockstateVariants: 2_500,
    productDimensionSize: 800,
    productBudget: 2_000
  }),
  smoke: Object.freeze({
    warmupIterations: 0,
    measuredIterations: 1,
    semanticResources: 80,
    blockstateVariants: 120,
    productDimensionSize: 40,
    productBudget: 100
  })
});

export function resolveRsglBenchmarkProfile(name) {
  const profile = profiles[name];
  if (!profile) {
    throw new Error(`Unknown RSGL benchmark profile '${name}'.`);
  }
  return profile;
}

export function createRsglBenchmarkScenarios(core, profile) {
  return [
    createSingleFileSemanticScenario(core, profile.semanticResources),
    createLargeBlockstateScenario(core, profile.blockstateVariants),
    createBoundedProductScenario(core, profile.productDimensionSize, profile.productBudget)
  ];
}

function createSingleFileSemanticScenario(core, resourceCount) {
  const fileName = syntheticFileName("single-file-semantic.rsgl");
  const source = [
    "namespace benchmark",
    "template panel(offset: Number) -> model {",
    "  element from [0, 0, 0] to [1, 1, 1]",
    "}",
    ...Array.from({ length: resourceCount }, (_, index) =>
      `model block semantic_${pad(index)} { use panel(${index % 16}) }`
    )
  ].join("\n");

  return {
    name: "single-file-parse-semantic",
    workItems: resourceCount,
    inputBytes: Buffer.byteLength(source),
    run() {
      const module = core.parseRsgl(source);
      const semantic = core.bindRsglModule(module, { fileName });
      return { module, semantic };
    },
    validate(result) {
      assert.deepEqual(result.module.diagnostics, [], "single-file parse produced diagnostics");
      assert.deepEqual(result.semantic.diagnostics, [], "single-file semantic analysis produced diagnostics");
      assert.equal(result.semantic.outputResources.length, resourceCount);
      assert.ok(result.semantic.symbols.some(symbol => symbol.kind === "template" && symbol.name === "panel"));
      return {
        outputs: result.semantic.outputResources.length,
        diagnostics: 0,
        sourceMappings: 0
      };
    }
  };
}

function createLargeBlockstateScenario(core, variantCount) {
  const fileName = syntheticFileName("large-canonical-blockstate.rsgl");
  const modelId = "benchmark:block/shared";
  const source = [
    "namespace benchmark",
    "model block shared {}",
    "blockstate variants large {",
    ...Array.from({ length: variantCount }, (_, index) =>
      `  case { index: "${pad(index)}" } => ${modelId}`
    ),
    "}"
  ].join("\n");
  const module = core.parseRsgl(source);
  assert.deepEqual(module.diagnostics, [], "large blockstate fixture did not parse");

  return {
    name: "large-canonical-blockstate-compile",
    workItems: variantCount,
    inputBytes: Buffer.byteLength(source),
    run() {
      return core.compileRsglModule(module, { fileName });
    },
    validate(result) {
      assert.deepEqual(result.diagnostics, [], "large blockstate compilation produced diagnostics");
      assert.equal(result.units.length, 2, "expected one model and one blockstate resource");
      const blockstate = result.units.find(unit => unit.kind === "blockstate");
      assert.ok(blockstate, "missing compiled blockstate resource");
      const variants = blockstate.content.variants;
      assert.ok(variants && typeof variants === "object" && !Array.isArray(variants));
      assert.equal(Object.keys(variants).length, variantCount);

      const firstKey = `index=${pad(0)}`;
      const lastKey = `index=${pad(variantCount - 1)}`;
      assert.equal(variants[firstKey].model, modelId);
      assert.equal(variants[lastKey].model, modelId);
      assert.equal(blockstate.sourceMap.mappings.length, variantCount * 2 + 2);
      const lastModelPath = `/variants/${lastKey}/model`;
      const lastModelMapping = blockstate.sourceMap.mappings.find(mapping =>
        mapping.generatedPath === lastModelPath
      );
      assert.ok(lastModelMapping, `missing source mapping for ${lastModelPath}`);
      assert.equal(
        source.slice(lastModelMapping.sourceRange.start, lastModelMapping.sourceRange.end),
        modelId
      );

      return {
        outputs: result.units.length,
        diagnostics: result.diagnostics.length,
        sourceMappings: result.units.reduce((count, unit) => count + unit.sourceMap.mappings.length, 0)
      };
    }
  };
}

function createBoundedProductScenario(core, dimensionSize, maxEvaluationItems) {
  const fileName = syntheticFileName("bounded-product.rsgl");
  const source = [
    "namespace benchmark",
    "model block bounded_product {",
    `  merge { values: product({ left: 0..${dimensionSize - 1}, right: 0..${dimensionSize - 1} }) }`,
    "}"
  ].join("\n");
  const module = core.parseRsgl(source);
  assert.deepEqual(module.diagnostics, [], "bounded product fixture did not parse");

  return {
    name: "bounded-product-budget",
    workItems: dimensionSize * dimensionSize,
    inputBytes: Buffer.byteLength(source),
    run() {
      return core.compileRsglModule(module, { fileName, maxEvaluationItems });
    },
    validate(result) {
      assert.equal(result.units.length, 0, "over-budget product must not emit a partial resource");
      assert.deepEqual(
        result.diagnostics.map(diagnostic => diagnostic.code),
        ["rsgl.collectionExpansionLimit"]
      );
      assert.match(result.diagnostics[0].message, new RegExp(`maxEvaluationItems=${maxEvaluationItems}`));
      return {
        outputs: 0,
        diagnostics: result.diagnostics.length,
        sourceMappings: 0
      };
    }
  };
}

function syntheticFileName(name) {
  return path.resolve("synthetic benchmark", "非ASCII", name);
}

function pad(value) {
  return String(value).padStart(5, "0");
}
