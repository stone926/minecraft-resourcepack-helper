import * as assert from "node:assert/strict";
import type { ExprNode, TextRange } from "../../src/parser";
import { parseRsgl } from "../../src/parser";
import {
  compileBlockstateResource,
  type BlockstateCompileOptions
} from "../../src/compiler/blockstateCompiler";
import {
  createEvaluatedResourceId,
  createEvaluatedTextureVariable,
  type RsglResourceValueObservation
} from "../../src/compiler/evaluatedResourceValues";
import {
  evaluateExpressionResult,
  type EvaluationContext,
  type EvaluationValue
} from "../../src/compiler/evaluate";
import type {
  JsonValue,
  ResourceKind,
  ResourceUnit,
  RsglCompileDiagnostic,
  RsglMapping
} from "../../src/compiler/ir";
import { checkJsonResourceReference } from "../../src/compiler/jsonResourceReferenceValidation";
import {
  createJsonValueLoweringHost,
  evaluateJsonExpression,
  type JsonRuntimeValueAdapter,
  lowerJsonEvaluationResult
} from "../../src/compiler/jsonValueLowerer";
import {
  beginResourceValueValidation,
  completeResourceValueValidation
} from "../../src/compiler/resourceValueValidation";
import { canonicalizeAndValidateResourceUnits } from "../../src/compiler/validation";
import type { RsglCompileContext } from "../../src/compiler/templateExpansion";

describe("RSGL resource-value JSON adapter", () => {
  it("recursively lowers typed values, preserves strings, records origins, and composes adapters", () => {
    const model = requiredResourceId("block/stone", "model", "demo");
    const texture = requiredResourceId("block/stone", "texture", "demo");
    const variable = createEvaluatedTextureVariable("#side");
    assert.ok(variable);
    const customValue = { kind: "custom", value: "custom-value" };
    const parsed = parsedExpression(
      "{ model: modelValue, nested: [textureValue, textureVariable], plain: \"unchanged\", custom: customValue }"
    );
    const observations: RsglResourceValueObservation[] = [];
    const customPaths: string[] = [];
    const value = evaluateJsonExpression(
      parsed.expression,
      evaluationContext({
        modelValue: model,
        textureValue: texture,
        textureVariable: variable,
        customValue
      }),
      {
        onResourceValueObservation: observation => observations.push(observation),
        jsonValueAdapters: [customAdapter(customValue, customPaths)]
      },
      "/payload"
    );

    assert.deepStrictEqual(value, {
      model: "demo:block/stone",
      nested: ["demo:block/stone", "#side"],
      plain: "unchanged",
      custom: "custom-value"
    });
    assert.deepStrictEqual(
      observations.map(observation => [observation.generatedPath, observation.valueKind]),
      [
        ["/payload/model", "model"],
        ["/payload/nested/0", "texture"],
        ["/payload/nested/1", "textureVariable"]
      ]
    );
    assert.deepStrictEqual(
      observations.map(observation => parsed.source.slice(observation.range.start, observation.range.end)),
      ["modelValue", "textureValue", "textureVariable"]
    );
    assert.ok(observations.every(observation => observation.sourceFile === "adapter.rsgl"));
    assert.deepStrictEqual(customPaths, ["/payload/custom"]);
    assert.strictEqual(JSON.stringify(value).includes("resourceId"), false);
    assert.strictEqual(JSON.stringify(value).includes("textureVariable"), false);
  });

  it("preserves ordinary JSON objects that resemble compiler runtime tags", () => {
    const resourceLike = {
      kind: "resourceId",
      resourceKind: "model",
      namespace: "demo",
      path: "block/stone"
    };
    const textureVariableLike = { kind: "textureVariable", value: "#side" };
    const observations: RsglResourceValueObservation[] = [];
    const diagnostics: Array<{ code: string; message: string }> = [];
    const parsed = parsedExpression("{ resourceLike: resourceLike, textureVariableLike: textureVariableLike }");
    const value = evaluateJsonExpression(
      parsed.expression,
      evaluationContext({ resourceLike, textureVariableLike }),
      {
        onResourceValueObservation: observation => observations.push(observation),
        onError: (code, message) => diagnostics.push({ code, message })
      }
    );

    assert.deepStrictEqual(value, { resourceLike, textureVariableLike });
    assert.deepStrictEqual(observations, []);
    assert.deepStrictEqual(diagnostics, []);
  });

  it("rejects malformed nominal compiler tags without leaking JSON objects", () => {
    const malformed = requiredResourceId("block/stone", "model", "demo");
    (malformed as unknown as { namespace: string }).namespace = "invalid:namespace";
    const observations: RsglResourceValueObservation[] = [];
    const diagnostics: Array<{ code: string; message: string }> = [];
    const parsed = parsedExpression("{ nested: malformed }");
    const value = evaluateJsonExpression(
      parsed.expression,
      evaluationContext({ malformed }),
      {
        onResourceValueObservation: observation => observations.push(observation),
        onError: (code, message) => diagnostics.push({ code, message })
      }
    );

    assert.strictEqual(value, undefined);
    assert.deepStrictEqual(observations, []);
    assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.invalidResourceRuntimeValue"
    ]);
    assert.ok(diagnostics[0].message.includes("Malformed compiler resource value"));
  });

  it("installs the resource adapter in the shared lowering sink alongside custom adapters", () => {
    const model = requiredResourceId("block/stone", "model", "demo");
    const customValue = { kind: "custom", value: 7 };
    const parsed = parsedExpression("{ model: modelValue, custom: customValue }");
    const context = evaluationContext({ modelValue: model, customValue });
    const observations: RsglResourceValueObservation[] = [];
    const customPaths: string[] = [];
    const loweringHost = createJsonValueLoweringHost(context, {
      onError: () => assert.fail("Expected the value to be serializable."),
      onResourceValueObservation: observation => observations.push(observation),
      jsonValueAdapters: [customAdapter(customValue, customPaths)]
    });
    loweringHost.generatedPathPrefix = "/entry";
    const value = lowerJsonEvaluationResult(
      evaluateExpressionResult(parsed.expression, context),
      parsed.expression.range,
      loweringHost
    );

    assert.deepStrictEqual(value, { model: "demo:block/stone", custom: 7 });
    assert.deepStrictEqual(observations.map(observation => observation.generatedPath), [
      "/entry/model"
    ]);
    assert.deepStrictEqual(customPaths, ["/entry/custom"]);
  });
});

describe("RSGL resource-value consumer validation", () => {
  it("short-circuits a wrong resource kind before canonicalization or resolution", () => {
    const range = { start: 10, end: 22 };
    const unit = validationUnit(
      "model",
      { parent: "demo:block/wrong" },
      [observation("/parent", "texture", range)]
    );
    let resolverCalls = 0;
    const diagnostics = canonicalizeAndValidateResourceUnits([unit], {
      resourceExists: () => {
        resolverCalls++;
        return true;
      }
    });

    assert.strictEqual(resolverCalls, 0);
    assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.resourceIdKindMismatch"
    ]);
    assert.ok(diagnostics[0].message.includes("TextureId"));
    assert.ok(diagnostics[0].message.includes("ModelId"));
    assert.deepStrictEqual(diagnostics[0].range, range);
  });

  it("reports one dedicated error for a TextureVariable in a non-texture consumer", () => {
    const range = { start: 3, end: 8 };
    const unit = validationUnit(
      "model",
      { parent: "#side" },
      [observation("/parent", "textureVariable", range)]
    );
    const diagnostics: RsglCompileDiagnostic[] = [];
    let resolverCalls = 0;

    beginResourceValueValidation(unit);
    const checked = checkJsonResourceReference(
      unit.content as Record<string, JsonValue>,
      "parent",
      "model",
      unit,
      {
        resourceExists: () => {
          resolverCalls++;
          return true;
        }
      },
      diagnostics,
      "/parent"
    );
    completeResourceValueValidation(unit, diagnostics);

    assert.strictEqual(checked.available, false);
    assert.strictEqual(resolverCalls, 0);
    assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.textureVariableInvalidContext"
    ]);
  });

  it("accepts a TextureVariable only at a model texture-reference consumer", () => {
    const unit = validationUnit(
      "model",
      { textures: { layer0: "#side" } },
      [observation("/textures/layer0", "textureVariable", { start: 1, end: 6 })]
    );
    const diagnostics: RsglCompileDiagnostic[] = [];

    beginResourceValueValidation(unit);
    const checked = checkJsonResourceReference(
      (unit.content as { textures: Record<string, JsonValue> }).textures,
      "layer0",
      "modelTexture",
      unit,
      {},
      diagnostics,
      "/textures/layer0"
    );
    completeResourceValueValidation(unit, diagnostics);

    assert.strictEqual(checked.available, true);
    assert.deepStrictEqual(diagnostics, []);
  });

  it("rejects a TextureVariable that escapes into generic JSON", () => {
    const range = { start: 12, end: 17 };
    const unit = validationUnit(
      "json",
      { arbitrary: "#side" },
      [observation("/arbitrary", "textureVariable", range)]
    );
    const diagnostics = canonicalizeAndValidateResourceUnits([unit]);

    assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.textureVariableInvalidContext"
    ]);
    assert.deepStrictEqual(diagnostics[0].range, range);
  });
});

describe("RSGL blockstate resource-value observation paths", () => {
  it("rebases a typed scalar variant head to its final model path", () => {
    assertWrongBlockstateApplyPath(
      "blockstate variants path_test { case { facing: north } => wrong }",
      "/variants/facing=north/model"
    );
  });

  it("rebases a typed scalar multipart head through the actual entry and apply paths", () => {
    assertWrongBlockstateApplyPath(
      "blockstate multipart path_test { part always => minecraft:builtin/generated; part always => wrong }",
      "/multipart/1/apply/model"
    );
  });

  it("rebases root append observations through the merger's array offset", () => {
    const wrong = requiredResourceId("block/wrong", "texture", "demo");
    const fragment = {
      multipart: [{ apply: { model: wrong } }]
    } as unknown as EvaluationValue;
    const observations: RsglResourceValueObservation[] = [];
    const errors: string[] = [];
    const unit = compileDirectBlockstate(
      "blockstate multipart root_append { part always => minecraft:builtin/generated; merge append fragment }",
      { fragment },
      observations,
      errors
    );

    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(
      observations.map(item => [item.generatedPath, item.valueKind]),
      [["/multipart/1/apply/model", "texture"]]
    );
    unit.validation = { resourceValueObservations: observations };
    const diagnostics = canonicalizeAndValidateResourceUnits([unit]);
    assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.resourceIdKindMismatch"
    ]);
  });

  it("does not commit observations for strict-merge content that was not applied", () => {
    const wrong = requiredResourceId("block/wrong", "texture", "demo");
    const fragment = {
      variants: { "missing=true": { model: wrong } }
    } as unknown as EvaluationValue;
    const observations: RsglResourceValueObservation[] = [];
    const errors: string[] = [];
    compileDirectBlockstate(
      "blockstate variants root_strict { case { facing: north } => minecraft:builtin/generated; merge strict fragment }",
      { fragment },
      observations,
      errors
    );

    assert.deepStrictEqual(errors, ["rsgl.mergeFieldNotFound"]);
    assert.deepStrictEqual(observations, []);
  });

  it("drops an earlier typed observation when a later plain root merge overwrites it", () => {
    const wrong = requiredResourceId("block/wrong", "texture", "demo");
    const replacement = {
      variants: { "facing=north": { model: "minecraft:builtin/generated" } }
    } as EvaluationValue;
    const observations: RsglResourceValueObservation[] = [];
    const errors: string[] = [];
    const unit = compileDirectBlockstate(
      "blockstate variants root_overwrite { case { facing: north } => wrong; merge replacement }",
      { wrong, replacement },
      observations,
      errors
    );

    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(observations, []);
    assert.deepStrictEqual(unit.content, {
      variants: { "facing=north": { model: "minecraft:builtin/generated" } }
    });
  });
});

function assertWrongBlockstateApplyPath(source: string, expectedPath: string): void {
  const wrong = requiredResourceId("block/wrong", "texture", "demo");
  const observations: RsglResourceValueObservation[] = [];
  const errors: string[] = [];
  const unit = compileDirectBlockstate(source, { wrong }, observations, errors);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(
    observations.map(item => [item.generatedPath, item.valueKind]),
    [[expectedPath, "texture"]]
  );
  unit.validation = { ...unit.validation, resourceValueObservations: observations };
  let resolverCalls = 0;
  const diagnostics = canonicalizeAndValidateResourceUnits([unit], {
    resourceExists: () => {
      resolverCalls++;
      return true;
    }
  });
  assert.strictEqual(resolverCalls, 0);
  assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), [
    "rsgl.resourceIdKindMismatch"
  ]);
}

function compileDirectBlockstate(
  source: string,
  values: Record<string, EvaluationValue>,
  observations: RsglResourceValueObservation[],
  errors: string[]
): ResourceUnit {
  const module = parseRsgl(source);
  const statement = module.statements[0];
  assert.ok(statement?.kind === "ResourceDecl" && statement.resourceKind === "blockstate");
  const context: RsglCompileContext = {
    namespace: "demo",
    variables: new Map(Object.entries(values)),
    sourceFile: "blockstate-paths.rsgl",
    expansionStack: []
  };
  const options: BlockstateCompileOptions = {
    resolveTemplate: () => undefined,
    expandUse: () => undefined,
    resolveTemplateDispatch: () => {
      throw new Error("No template dispatch is expected in this fixture.");
    },
    onError: code => errors.push(code),
    onResourceValueObservation: observation => observations.push(observation),
    sourceMap: (generatedFile, node, mappingContext, mappings) => ({
      generatedFile,
      mappings: [directMapping("", node.range, mappingContext), ...mappings]
    }),
    sourceMapping: (generatedPath, sourceRange, mappingContext) =>
      directMapping(generatedPath, sourceRange, mappingContext)
  };
  const unit = compileBlockstateResource(
    statement,
    context,
    options
  );
  assert.ok(unit);
  return unit;
}

function directMapping(
  generatedPath: string,
  sourceRange: TextRange,
  context: RsglCompileContext
): RsglMapping {
  return {
    generatedPath,
    sourceFile: context.sourceFile ?? "blockstate-paths.rsgl",
    sourceRange,
    reason: context.mappingReason ?? "direct",
    expansionStack: context.expansionStack ?? []
  };
}

function validationUnit(
  kind: ResourceKind,
  content: JsonValue,
  observations: RsglResourceValueObservation[]
): ResourceUnit {
  const rootRange = { start: 0, end: 1 };
  return {
    id: { namespace: "demo", path: "fixture" },
    kind,
    outputPath: `fixture/${kind}.json`,
    content,
    validation: { resourceValueObservations: observations },
    mergePolicy: { kind: "replace" },
    sourceMap: {
      generatedFile: `fixture/${kind}.json`,
      mappings: [
        directValidationMapping("", rootRange),
        ...observations.map(item => directValidationMapping(item.generatedPath, item.range))
      ]
    }
  };
}

function directValidationMapping(generatedPath: string, sourceRange: TextRange): RsglMapping {
  return {
    generatedPath,
    sourceFile: "validation.rsgl",
    sourceRange,
    reason: "direct",
    expansionStack: []
  };
}

function observation(
  generatedPath: string,
  valueKind: RsglResourceValueObservation["valueKind"],
  range: TextRange
): RsglResourceValueObservation {
  return { generatedPath, valueKind, range, sourceFile: "validation.rsgl" };
}

function requiredResourceId(
  value: string,
  kind: "generic" | "model" | "texture",
  namespace: string
): EvaluationValue {
  const resource = createEvaluatedResourceId(value, kind, namespace);
  assert.ok(resource);
  return resource as EvaluationValue;
}

function evaluationContext(values: Record<string, unknown>): EvaluationContext {
  return {
    namespace: "demo",
    sourceFile: "adapter.rsgl",
    variables: new Map(Object.entries(values).map(([name, value]) => [
      name,
      value as EvaluationValue
    ]))
  };
}

function customAdapter(value: object, paths: string[]): JsonRuntimeValueAdapter {
  return {
    lower(candidate, context) {
      if (candidate !== value) {
        return undefined;
      }
      paths.push(context.generatedPath);
      return {
        kind: "value",
        value: (value as { value: JsonValue }).value
      };
    }
  };
}

function parsedExpression(source: string): { expression: ExprNode; source: string } {
  const moduleSource = `let result = ${source}`;
  const module = parseRsgl(moduleSource);
  const statement = module.statements[0];
  if (!statement || statement.kind !== "LetDecl") {
    throw new Error(`Expected a let expression for '${source}'.`);
  }
  return { expression: statement.value, source: moduleSource };
}
