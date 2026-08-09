import * as assert from "node:assert";
import * as path from "node:path";
import type { ExprNode } from "../../src/parser";
import { parseRsgl } from "../../src/parser";
import {
  bindRsglModule,
  bindRsglProgram
} from "../../src/semantic";
import {
  jsonType,
  modelIdType,
  textureIdType,
  type RsglType
} from "../../src/semantic/types";
import {
  childEvaluationContext,
  evaluateExpression,
  evaluateExpressionResult,
  materializeEvaluationPathOrigins,
  type EvaluationContext,
  type EvaluationValue
} from "../../src/compiler/evaluate";
import {
  createProgramCompileEnvironments,
  createStandaloneCompileEnvironment
} from "../../src/compiler/environment";
import {
  createTemplateExpansion,
  type RsglCompileContext
} from "../../src/compiler/templateExpansion";
import {
  createEvaluatedResourceId,
  isEvaluatedResourceId,
  isEvaluatedTextureVariable
} from "../../src/compiler/evaluatedResourceValues";
import { isJsonObject } from "../../src/compiler/jsonValues";
import { applyModelImpl } from "../../src/compiler/modelImpl";
import { compileSource } from "./helpers/compile";

describe("RSGL typed resource runtime values", () => {
  it("creates concrete brands from contextual scalar, list, record, and optional facts", () => {
    const scalar = parseExpression("\"block/stone\"");
    const list = parseExpression("[\"block/stone\", \"other:block/dirt\"]");
    const record = parseExpression("{ model: \"block/cube\", untouched: \"plain text\" }");
    const optional = parseExpression("\"block/optional\"");
    const recordType: RsglType = {
      kind: "Object",
      properties: new Map([
        ["model", { type: modelIdType, optional: false }],
        ["untouched", { type: jsonType, optional: false }]
      ])
    };
    const context = evaluationContext("demo", new Map([
      [scalar, modelIdType],
      [list, { kind: "List", elementType: textureIdType }],
      [record, recordType],
      [optional, { kind: "Union", options: [modelIdType, { kind: "Missing" }] }]
    ]));

    assertResourceId(evaluateExpression(scalar, context), "model", "demo", "block/stone");
    const listValue = evaluateExpression(list, context);
    assert.ok(Array.isArray(listValue));
    assertResourceId(listValue[0], "texture", "demo", "block/stone");
    assertResourceId(listValue[1], "texture", "other", "block/dirt");
    const recordValue = evaluateExpression(record, context);
    assert.ok(isJsonObject(recordValue));
    assertResourceId(recordValue.model, "model", "demo", "block/cube");
    assert.strictEqual(recordValue.untouched, "plain text");
    assertResourceId(evaluateExpression(optional, context), "model", "demo", "block/optional");
  });

  it("keeps generic JSON strings unbranded and diagnoses ambiguous unions", () => {
    const jsonExpression = parseExpression("\"block/plain\"");
    const ambiguousExpression = parseExpression("\"block/ambiguous\"");
    const errors: string[] = [];
    const context: EvaluationContext = {
      ...evaluationContext("demo", new Map([
        [jsonExpression, jsonType],
        [ambiguousExpression, {
          kind: "Union",
          options: [modelIdType, textureIdType]
        }]
      ])),
      onError: code => errors.push(code)
    };

    assert.strictEqual(evaluateExpression(jsonExpression, context), "block/plain");
    assert.strictEqual(evaluateExpression(ambiguousExpression, context), undefined);
    assert.deepStrictEqual(errors, ["rsgl.ambiguousResourceIdConversion"]);
  });

  it("constructs, validates, and scalarizes branded IDs without leaking runtime objects", () => {
    const existing = createEvaluatedResourceId("block/existing", "model", "demo");
    const texture = createEvaluatedResourceId("block/texture", "texture", "demo");
    assert.ok(existing && texture);
    const errors: string[] = [];
    let failures = 0;
    const context: EvaluationContext = {
      ...evaluationContext("demo", undefined, new Map<string, EvaluationValue>([
        ["existing", existing],
        ["wrongKind", texture]
      ])),
      onError: code => errors.push(code),
      onEvaluationFailure: () => {
        failures += 1;
      }
    };

    const constructed = evaluate("model_id(\"block/stone\")", context);
    assertResourceId(constructed, "model", "demo", "block/stone");
    assert.strictEqual(evaluate("model_id(existing)", context), existing);
    assert.strictEqual(evaluate("model_id(wrongKind)", context), undefined);
    assert.strictEqual(evaluate("texture_id(\"#side\")", context), undefined);
    assert.strictEqual(evaluate("model_id(\"Bad Resource\")", context), undefined);
    assert.deepStrictEqual(errors, [
      "rsgl.resourceIdKindMismatch",
      "rsgl.invalidConstructedResourceId",
      "rsgl.invalidConstructedResourceId"
    ]);
    assert.strictEqual(failures, 3);

    assert.strictEqual(
      evaluate("`prefix/${model_id(\"block/stone\")}`", context),
      "prefix/demo:block/stone"
    );
    assert.strictEqual(
      evaluate("model_path(model_id(\"block/stone\"))", context),
      "assets/demo/models/block/stone.json"
    );
    assert.strictEqual(evaluate("resource_namespace(existing)", context), "demo");
    assert.strictEqual(evaluate("resource_path(existing)", context), "block/existing");
    assert.deepStrictEqual(
      evaluate("{ [model_id(\"block/key\")]: true }", context),
      { "demo:block/key": true }
    );
    assert.strictEqual(evaluate("has(existing, \"namespace\")", context), false);
    assert.strictEqual(evaluate("product(existing)", context), undefined);
    assert.strictEqual(errors.at(-1), "rsgl.collectionExpected");
    assert.strictEqual(failures, 4);
    assert.strictEqual(evaluate("existing.namespace", context), undefined);
    assert.strictEqual(isJsonObject(constructed), false);
  });

  it("preserves texture-variable taint through text-producing expressions", () => {
    const errors: string[] = [];
    let failures = 0;
    const context: EvaluationContext = {
      ...evaluationContext("demo"),
      onError: code => errors.push(code),
      onEvaluationFailure: () => {
        failures += 1;
      }
    };

    const concatenated = evaluate("#inside + \"\"", context);
    assert.ok(isEvaluatedTextureVariable(concatenated));
    assert.strictEqual(concatenated.value, "#inside");

    const interpolated = evaluate("`${#inside}`", context);
    assert.ok(isEvaluatedTextureVariable(interpolated));
    assert.strictEqual(interpolated.value, "#inside");

    assert.strictEqual(evaluate("#inside + \"!\"", context), undefined);
    assert.deepStrictEqual(errors, ["rsgl.textureVariableInvalidContext"]);
    assert.strictEqual(failures, 1);
  });

  it("does not cascade a shape diagnostic after a nested constructor kind mismatch", () => {
    const source = [
      "namespace demo",
      "let wrong = model_id(texture_id(\"block/texture\"))"
    ].join("\n");

    const result = compileSource(source.split("\n"));

    assert.deepStrictEqual(result.diagnostics.map(item => [
      item.code,
      source.slice(item.range.start, item.range.end)
    ]), [[
      "rsgl.resourceIdKindMismatch",
      "texture_id(\"block/texture\")"
    ]]);
  });

  it("does not execute a constructor when a lexical value shadows its name", () => {
    let failures = 0;
    const context: EvaluationContext = {
      ...evaluationContext(
        "demo",
        undefined,
        new Map<string, EvaluationValue>([["model_id", "shadowed"]])
      ),
      onEvaluationFailure: () => {
        failures += 1;
      }
    };

    assert.strictEqual(evaluate("model_id(\"block/stone\")", context), undefined);
    assert.strictEqual(failures, 1);
  });

  it("does not execute a constructor while a later local shadow is pre-evaluated", () => {
    const module = parseRsgl([
      "let result = model_id(\"block/stone\")",
      "let model_id: (String) -> String = value => value"
    ].join("\n"));
    const model = bindRsglModule(module, { fileName: "forward-shadow.rsgl" });
    let failures = 0;
    const environment = createStandaloneCompileEnvironment(model, "demo", {
      onEvaluationFailure: () => {
        failures += 1;
      }
    });

    assert.deepStrictEqual(model.diagnostics, []);
    assert.strictEqual(environment.localValueBindings.get("result")?.value, undefined);
    assert.strictEqual(failures, 1);
  });

  it("attributes an interpolated scalar to the complete template-string expression", () => {
    const expression = parseExpression("`block/${suffix}`");
    const sourceFile = "template-string-origin.rsgl";
    const suffixRange = { start: 0, end: 9 };
    const result = evaluateExpressionResult(expression, {
      ...evaluationContext(
        "demo",
        undefined,
        new Map<string, EvaluationValue>([["suffix", "dynamic"]])
      ),
      sourceFile,
      valueOrigins: new Map([["suffix", { sourceFile, sourceRange: suffixRange }]])
    });
    const origin = materializeEvaluationPathOrigins(result, sourceFile)
      .find(item => item.generatedPath === "");

    assert.ok(origin);
    assert.deepStrictEqual(origin.sourceRange, expression.range);
    assert.notDeepStrictEqual(origin.sourceRange, suffixRange);
    assert.strictEqual(origin.sourceFile, sourceFile);
  });

  it("retains the constructor argument as the branded value source origin", () => {
    const expression = parseExpression("model_id(`block/${\"stone\"}`)");
    assert.strictEqual(expression.kind, "CallExpr");
    const argument = expression.kind === "CallExpr" ? expression.args[0]?.value : undefined;
    assert.ok(argument);
    const result = evaluateExpressionResult(expression, {
      ...evaluationContext("demo"),
      sourceFile: "constructor-origin.rsgl"
    });
    const origin = materializeEvaluationPathOrigins(
      result,
      "constructor-origin.rsgl"
    ).find(item => item.generatedPath === "");

    assert.ok(origin);
    assert.deepStrictEqual(origin.sourceRange, argument.range);
    assert.strictEqual(origin.sourceFile, "constructor-origin.rsgl");
  });

  it("reports dynamic conversion failures during environment pre-evaluation", () => {
    const module = parseRsgl([
      "let suffix = \"Bad Resource\"",
      "let direct: ModelId = \"block/direct\"",
      "let invalid: ModelId = `block/${suffix}`"
    ].join("\n"));
    const model = bindRsglModule(module, { fileName: "environment.rsgl" });
    const errors: string[] = [];
    let failures = 0;
    const environment = createStandaloneCompileEnvironment(model, "environment", {
      onError: code => errors.push(code),
      onEvaluationFailure: () => {
        failures += 1;
      }
    });

    assertResourceId(
      environment.localValueBindings.get("direct")?.value,
      "model",
      "environment",
      "block/direct"
    );
    assert.strictEqual(environment.localValueBindings.get("invalid")?.value, undefined);
    assert.deepStrictEqual(errors, ["rsgl.invalidConstructedResourceId"]);
    assert.strictEqual(failures, 1);
  });

  it("uses caller namespace for explicit template arguments and definition namespace for defaults", () => {
    const module = parseRsgl([
      "template emit(",
      "  explicit: ModelId,",
      "  inherited: ModelId = explicit,",
      "  fallback: ModelId = \"block/default\"",
      ") { }"
    ].join("\n"));
    const model = bindRsglModule(module, { fileName: "definition.rsgl" });
    const environment = createStandaloneCompileEnvironment(model, "definition");
    const definition = environment.allTemplates.get("emit");
    assert.ok(definition);
    const call = parseExpression("emit(\"block/caller\")");
    const errors: string[] = [];
    const diagnostics: string[] = [];
    const callContext: RsglCompileContext = {
      namespace: "caller",
      variables: new Map(),
      templates: environment.allTemplates,
      sourceFile: "caller.rsgl"
    };
    const expansion = createTemplateExpansion(call, callContext, {
      templates: environment.allTemplates,
      createChildContext: (context, values, metadata) => ({
        ...childEvaluationContext(context, values, metadata),
        templates: context.templates
      }),
      onError: code => errors.push(code),
      onDiagnostic: diagnostic => diagnostics.push(diagnostic.code)
    }, definition);

    assert.ok(expansion);
    assertResourceId(
      expansion.context.variables.get("explicit"),
      "model",
      "caller",
      "block/caller"
    );
    assertResourceId(
      expansion.context.variables.get("inherited"),
      "model",
      "caller",
      "block/caller"
    );
    assertResourceId(
      expansion.context.variables.get("fallback"),
      "model",
      "definition",
      "block/default"
    );
    assert.strictEqual(expansion.context.resolvedExpectedTypes, model.resolvedExpectedTypes);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(diagnostics, []);
  });

  it("does not cascade a second template argument diagnostic after evaluation fails", () => {
    const module = parseRsgl("template emit(model: ModelId) -> model { }");
    const model = bindRsglModule(module, { fileName: "definition.rsgl" });
    const environment = createStandaloneCompileEnvironment(model, "definition");
    const definition = environment.allTemplates.get("emit");
    assert.ok(definition);
    const call = parseExpression("emit(texture_id(\"block/wrong\"))");
    assert.ok(call.kind === "CallExpr" && call.args[0]);
    const argument = call.args[0].value;
    const errors: string[] = [];
    let failures = 0;
    const onError = (code: string) => errors.push(code);
    const callContext: RsglCompileContext = {
      namespace: "caller",
      variables: new Map(),
      templates: environment.allTemplates,
      sourceFile: "caller.rsgl",
      resolvedExpectedTypes: new Map([[argument, modelIdType]]),
      onError,
      onEvaluationFailure: () => {
        failures += 1;
      }
    };
    const expansion = createTemplateExpansion(call, callContext, {
      templates: environment.allTemplates,
      createChildContext: (context, values, metadata) => ({
        ...childEvaluationContext(context, values, metadata),
        templates: context.templates
      }),
      onError,
      onDiagnostic: () => undefined
    }, definition);

    assert.strictEqual(expansion, undefined);
    assert.deepStrictEqual(errors, ["rsgl.resourceIdKindMismatch"]);
    assert.strictEqual(failures, 1);
  });

  it("preserves caller and definition namespace boundaries through imported lambdas", () => {
    const libraryFile = path.resolve("pack", "typed-runtime-library.rsgl");
    const callerFile = path.resolve("pack", "typed-runtime-caller.rsgl");
    const program = bindRsglProgram([
      {
        fileName: libraryFile,
        module: parseRsgl([
          "namespace library",
          "let identity: (ModelId) -> ModelId = value => value",
          "let fallback: (ModelId) -> TextureId = value => \"block/fallback\"",
          "export { identity, fallback }"
        ].join("\n"))
      },
      {
        fileName: callerFile,
        module: parseRsgl([
          "namespace caller",
          "import { identity, fallback } from \"./typed-runtime-library.rsgl\"",
          "let kept = identity(\"block/input\")",
          "let returned = fallback(\"block/input\")"
        ].join("\n"))
      }
    ]);
    const environments = createProgramCompileEnvironments(
      program,
      { namespaceOverride: undefined, defaultNamespace: "minecraft" }
    );
    const caller = environments.get(path.normalize(callerFile));

    assertResourceId(caller?.localValueBindings.get("kept")?.value, "model", "caller", "block/input");
    assertResourceId(
      caller?.localValueBindings.get("returned")?.value,
      "texture",
      "library",
      "block/fallback"
    );
  });

  it("creates TextureVariable tags only at texture-reference boundaries", () => {
    const expression = parseExpression("\"#side\"");
    const context = evaluationContext("demo", new Map([
      [expression, { kind: "TextureRef" }]
    ]));
    const value = evaluateExpression(expression, context);

    assert.ok(isEvaluatedTextureVariable(value));
    assert.strictEqual(value.value, "#side");
    assert.strictEqual(isJsonObject(value), false);
  });

  it("accepts branded model and texture IDs at the model impl scalar seam", () => {
    const module = parseRsgl(
      "model block stone impl minecraft:block/cube_all(all: minecraft:block/stone) {}"
    );
    const statement = module.statements[0];
    assert.ok(statement?.kind === "ResourceDecl" && statement.impl);
    const impl = statement.impl;
    const parent = impl.kind === "CallExpr" ? impl.callee : impl;
    const texture = impl.kind === "CallExpr" ? impl.args[0]?.value : undefined;
    assert.ok(texture);
    const errors: string[] = [];
    const result = applyModelImpl(
      statement,
      "block",
      { content: {}, mappings: [] },
      evaluationContext("demo", new Map([
        [parent, modelIdType],
        [texture, textureIdType]
      ])),
      {
        onError: code => errors.push(code),
        createMapping: (generatedPath, sourceRange, validationOrigin) => ({
          generatedPath,
          sourceFile: "model-impl.rsgl",
          sourceRange,
          reason: "direct",
          expansionStack: [],
          ...(validationOrigin ? { validationOrigin } : {})
        })
      }
    );

    assert.deepStrictEqual(result.content, {
      parent: "minecraft:block/cube_all",
      textures: { all: "minecraft:block/stone" }
    });
    assert.deepStrictEqual(errors, []);
  });

  it("rejects wrong branded kinds at the model impl scalar seam", () => {
    const module = parseRsgl("model block stone impl parent(all: texture) {}");
    const statement = module.statements[0];
    assert.ok(statement?.kind === "ResourceDecl" && statement.impl?.kind === "CallExpr");
    const modelValue = createEvaluatedResourceId("block/model", "model", "demo");
    const textureValue = createEvaluatedResourceId("block/texture", "texture", "demo");
    assert.ok(modelValue && textureValue);
    const errors: string[] = [];
    const options = {
      onError: (code: string) => errors.push(code),
      createMapping: (generatedPath: string, sourceRange: { start: number; end: number }) => ({
        generatedPath,
        sourceFile: "model-impl.rsgl",
        sourceRange,
        reason: "direct" as const,
        expansionStack: []
      })
    };

    const wrongTexture = applyModelImpl(
      statement,
      "block",
      { content: {}, mappings: [] },
      evaluationContext("demo", undefined, new Map<string, EvaluationValue>([
        ["parent", modelValue],
        ["texture", modelValue]
      ])),
      options
    );
    const wrongParent = applyModelImpl(
      statement,
      "block",
      { content: {}, mappings: [] },
      evaluationContext("demo", undefined, new Map<string, EvaluationValue>([
        ["parent", textureValue],
        ["texture", textureValue]
      ])),
      options
    );

    assert.deepStrictEqual(wrongTexture.content, { parent: "demo:block/model" });
    assert.deepStrictEqual(wrongParent.content, {});
    assert.deepStrictEqual(errors, [
      "rsgl.resourceIdKindMismatch",
      "rsgl.resourceIdKindMismatch"
    ]);
  });
});

function evaluate(source: string, context: EvaluationContext): EvaluationValue {
  return evaluateExpression(parseExpression(source), context);
}

function parseExpression(source: string): ExprNode {
  const module = parseRsgl(`let result = ${source}`);
  const statement = module.statements[0];
  if (!statement || statement.kind !== "LetDecl") {
    throw new Error(`Expected a let expression for '${source}'.`);
  }
  return statement.value;
}

function evaluationContext(
  namespace: string,
  resolvedExpectedTypes?: ReadonlyMap<ExprNode, RsglType>,
  variables: Map<string, EvaluationValue> = new Map()
): EvaluationContext {
  return {
    namespace,
    variables,
    resolvedExpectedTypes
  };
}

function assertResourceId(
  value: unknown,
  resourceKind: "generic" | "model" | "texture",
  namespace: string,
  resourcePath: string
): void {
  assert.ok(isEvaluatedResourceId(value), `Expected a branded ${resourceKind} resource ID.`);
  assert.strictEqual(value.resourceKind, resourceKind);
  assert.strictEqual(value.namespace, namespace);
  assert.strictEqual(value.path, resourcePath);
}
