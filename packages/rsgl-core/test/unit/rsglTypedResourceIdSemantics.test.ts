import * as assert from "node:assert/strict";
import * as path from "node:path";
import { builtinRsglCompletions } from "../../src/completionData";
import { callablePresentation } from "../../src/languageIntelligence";
import {
  rsglResourceIdConstructors,
  typeKindForResourceValueKind
} from "../../src/resourceIdSemantics";
import {
  type CallExprNode,
  type ExprNode,
  type ListElementNode,
  type ObjectExprNode,
  type RsglModule,
  parseRsgl
} from "../../src/parser";
import { walkRsglModule } from "../../src/parser/astTraversal";
import {
  bindRsglModule,
  bindRsglProgram,
  formatType,
  isAssignable,
  type RsglSemanticModel
} from "../../src/semantic";
import { createBuiltinSymbols } from "../../src/semantic/builtins";
import {
  modelIdType,
  resourceIdType,
  stringType,
  textureIdType,
  textureRefType,
  textureVariableType
} from "../../src/semantic/types";

describe("RSGL typed resource id semantics", () => {
  it("records resolved facts through typed lets, records, lists, unions, and optional fields", () => {
    const source = [
      "type Bundle = { model: ModelId; fallback?: ModelId; textures: List<TextureId> }",
      "let family = \"stone\"",
      "let direct: ModelId = `block/${family}`",
      "let bundle: Bundle = {",
      "  model: \"block/base\",",
      "  fallback: \"block/fallback\",",
      "  textures: [\"block/one\", `block/${family}`]",
      "}",
      "let optional: Bundle = { model: \"block/only\", textures: [] }",
      "let nullable: ModelId | null = \"block/maybe\"",
      "let refs: List<TextureRef> = [\"#top\", \"block/bottom\"]"
    ].join("\n");
    const module = parseRsgl(source);
    const model = bindRsglModule(module);

    assert.deepStrictEqual(diagnosticCodes(model), []);
    assert.strictEqual(factKind(model, letValue(module, "direct")), "ModelId");

    const bundle = asObject(letValue(module, "bundle"));
    assert.strictEqual(factKind(model, bundle), "Object");
    assert.strictEqual(factKind(model, objectValue(bundle, "model")), "ModelId");
    assert.strictEqual(factKind(model, objectValue(bundle, "fallback")), "ModelId");
    const textures = objectValue(bundle, "textures");
    assert.ok(textures.kind === "ListExpr");
    assert.strictEqual(factKind(model, textures), "List");
    assert.deepStrictEqual(textures.elements.map(element => listElementFactKind(model, element)), [
      "TextureId",
      "TextureId"
    ]);

    const optional = asObject(letValue(module, "optional"));
    assert.strictEqual(factKind(model, objectValue(optional, "model")), "ModelId");
    assert.strictEqual(factKind(model, letValue(module, "nullable")), "ModelId");

    const refs = letValue(module, "refs");
    assert.ok(refs.kind === "ListExpr");
    assert.deepStrictEqual(refs.elements.map(element => listElementFactKind(model, element)), [
      "TextureVariable",
      "TextureId"
    ]);
  });

  it("keeps ambiguous ID unions unresolved and emits a constructor-directed diagnostic", () => {
    const module = parseRsgl("let ambiguous: ModelId | TextureId = \"block/value\"");
    const model = bindRsglModule(module);

    assert.deepStrictEqual(diagnosticCodes(model), ["rsgl.ambiguousResourceIdContext"]);
    const diagnostic = model.diagnostics[0];
    assert.ok(diagnostic.message.includes("model_id(...)"));
    assert.ok(diagnostic.message.includes("texture_id(...)"));
    assert.strictEqual(formatType(fact(model, letValue(module, "ambiguous"))), "ModelId | TextureId");
  });

  it("publishes concrete facts for reference sinks without branding pack-relative targets", () => {
    const module = parseRsgl([
      "namespace demo",
      "model block child {",
      "  parent other:block/parent",
      "  textures { all: other:block/texture }",
      "}",
      "model block implemented impl other:block/base(all: other:block/impl_texture) {}",
      "blockstate variants child { case * => other:block/variant_model }",
      "json \"assets/demo/custom/value.json\" { value \"unchanged\" }"
    ].join("\n"));
    const model = bindRsglModule(module);

    assert.deepStrictEqual(diagnosticCodes(model), []);
    assert.strictEqual(factKind(model, onlyResourceLocation(module, "other:block/parent")), "ModelId");
    assert.strictEqual(factKind(model, onlyResourceLocation(module, "other:block/texture")), "TextureId");
    assert.strictEqual(factKind(model, onlyResourceLocation(module, "other:block/base")), "ModelId");
    assert.strictEqual(factKind(model, onlyResourceLocation(module, "other:block/impl_texture")), "TextureId");
    assert.strictEqual(factKind(model, onlyResourceLocation(module, "other:block/variant_model")), "ModelId");

    const json = module.statements.find(statement =>
      statement.kind === "ResourceDecl" && statement.resourceKind === "json"
    );
    assert.ok(json?.kind === "ResourceDecl" && json.id);
    assert.strictEqual(model.resolvedExpectedTypes.has(json.id), false);
  });

  it("keeps the item model Json escape explicit and rejects branded non-model IDs", () => {
    const module = parseRsgl([
      "namespace demo",
      "let escaped: Json = { type: \"minecraft:model\", model: \"demo:item/escaped\" }",
      "item wrong_texture { model texture_id(\"item/wrong_texture\") }",
      "item wrong_resource { model resource_id(\"item/wrong_resource\") }",
      "item escaped_item { model escaped }"
    ].join("\n"));
    const model = bindRsglModule(module);

    assert.deepStrictEqual(model.diagnostics.map(item => [item.code, item.message]), [
      ["rsgl.resourceIdKindMismatch", "TextureId cannot be used where ModelId is required."],
      ["rsgl.resourceIdKindMismatch", "ResourceId cannot be used where ModelId is required."]
    ]);
  });

  it("enforces nominal ID assignability outside contextual conversion boundaries", () => {
    assert.strictEqual(isAssignable(resourceIdType, modelIdType), true);
    assert.strictEqual(isAssignable(resourceIdType, textureIdType), true);
    assert.strictEqual(isAssignable(modelIdType, resourceIdType), false);
    assert.strictEqual(isAssignable(textureIdType, resourceIdType), false);
    assert.strictEqual(isAssignable(modelIdType, textureIdType), false);
    assert.strictEqual(isAssignable(textureIdType, modelIdType), false);
    assert.strictEqual(isAssignable(modelIdType, stringType), false);
    assert.strictEqual(isAssignable(textureRefType, textureIdType), true);
    assert.strictEqual(isAssignable(textureRefType, textureVariableType), true);
    assert.strictEqual(isAssignable(textureRefType, resourceIdType), false);
    assert.strictEqual(isAssignable(textureRefType, stringType), false);

    const model = bindRsglModule(parseRsgl([
      "let texture: TextureId = \"block/texture\"",
      "let wrongModel: ModelId = texture",
      "let generic: ResourceId = \"block/generic\"",
      "let wrongTexture: TextureId = generic"
    ].join("\n")));
    assert.deepStrictEqual(diagnosticCodes(model), [
      "rsgl.resourceIdKindMismatch",
      "rsgl.resourceIdKindMismatch"
    ]);
  });

  it("derives pure constructor signatures and completions from the shared registry", () => {
    const builtins = new Map(createBuiltinSymbols().map(symbol => [symbol.name, symbol]));
    const completionByLabel = new Map(builtinRsglCompletions.map(item => [item.label, item]));

    for (const [name, kind] of Object.entries(rsglResourceIdConstructors)) {
      const expectedKind = typeKindForResourceValueKind(kind);
      const builtin = builtins.get(name);
      assert.ok(builtin?.signature, `${name} should have a concrete signature`);
      assert.strictEqual(builtin.effect, "pure");
      assert.strictEqual(builtin.signature.returnType.kind, expectedKind);
      assert.strictEqual(builtin.signature.parameters.length, 1);
      assert.strictEqual(builtin.signature.parameters[0].name, "value");
      assert.strictEqual(
        formatType(builtin.signature.parameters[0].type),
        `String | ${expectedKind}`
      );
      assert.strictEqual(
        callablePresentation(builtin)?.label,
        `${name}(value: String | ${expectedKind}): ${expectedKind}`
      );
      assert.ok(completionByLabel.get(name)?.detail.includes(expectedKind));
    }
  });

  it("accepts same-kind constructors, rejects cross-kind/narrowing calls, and preserves shadowing", () => {
    const module = parseRsgl([
      "let model = model_id(\"block/model\")",
      "let same = model_id(model)",
      "let texture = texture_id(\"block/texture\")",
      "let generic = resource_id(model)",
      "let wrongCross = model_id(texture)",
      "let genericOnly = resource_id(\"block/generic\")",
      "let wrongNarrow = texture_id(genericOnly)"
    ].join("\n"));
    const model = bindRsglModule(module);

    assert.deepStrictEqual(diagnosticCodes(model), [
      "rsgl.resourceIdKindMismatch",
      "rsgl.resourceIdKindMismatch"
    ]);
    assert.strictEqual(model.scope.symbols.get("model")?.type.kind, "ModelId");
    assert.strictEqual(model.scope.symbols.get("same")?.type.kind, "ModelId");
    assert.strictEqual(model.scope.symbols.get("texture")?.type.kind, "TextureId");
    assert.strictEqual(model.scope.symbols.get("generic")?.type.kind, "ResourceId");

    const shadowed = bindRsglModule(parseRsgl([
      "let model_id: (String) -> String = value => value",
      "let result = model_id(\"plain\")"
    ].join("\n")));
    assert.deepStrictEqual(diagnosticCodes(shadowed), []);
    assert.strictEqual(shadowed.scope.symbols.get("result")?.type.kind, "String");
  });

  it("records contextual facts across local calls and linked import/re-export calls", () => {
    const localModule = parseRsgl([
      "let local: (ModelId) -> TextureId = id => \"block/output\"",
      "let result = local(\"block/input\")"
    ].join("\n"));
    const local = bindRsglModule(localModule);
    assert.deepStrictEqual(diagnosticCodes(local), []);
    const localLambda = letValue(localModule, "local");
    assert.ok(localLambda.kind === "LambdaExpr");
    assert.strictEqual(factKind(local, localLambda.body), "TextureId");
    assert.strictEqual(factKind(local, onlyCall(localModule, "local").args[0].value), "ModelId");

    const mainFile = path.resolve("pack", "main.rsgl");
    const barrelFile = path.resolve("pack", "barrel.rsgl");
    const definitionsFile = path.resolve("pack", "definitions.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { forwarded } from \"./barrel.rsgl\"",
          "let result = forwarded(\"block/caller\")"
        ].join("\n"))
      },
      {
        fileName: barrelFile,
        module: parseRsgl("export { pass as forwarded } from \"./definitions.rsgl\"")
      },
      {
        fileName: definitionsFile,
        module: parseRsgl([
          "let pass: (ModelId) -> ModelId = value => value",
          "export { pass }"
        ].join("\n"))
      }
    ], { stdlibRoot: path.resolve("does-not-exist") });

    assert.deepStrictEqual(program.diagnostics.map(item => item.code), []);
    const main = program.models.find(model => model.fileName === mainFile);
    assert.ok(main);
    assert.strictEqual(
      factKind(main, onlyCall(main.module, "forwarded").args[0].value),
      "ModelId"
    );
  });
});

function diagnosticCodes(model: RsglSemanticModel): string[] {
  return model.diagnostics.map(item => item.code);
}

function letValue(module: RsglModule, name: string): ExprNode {
  const statement = module.statements.find(candidate =>
    candidate.kind === "LetDecl" && candidate.name?.text === name
  );
  assert.ok(statement?.kind === "LetDecl", `missing let ${name}`);
  return statement.value;
}

function asObject(expression: ExprNode): ObjectExprNode {
  assert.ok(expression.kind === "ObjectExpr");
  return expression;
}

function objectValue(expression: ObjectExprNode, name: string): ExprNode {
  for (const entry of expression.properties) {
    if (entry.kind === "ObjectSpread") {
      continue;
    }
    if ((entry.key.kind === "Identifier" && entry.key.text === name)
      || (entry.key.kind === "StringLiteral" && entry.key.value === name)) {
      return entry.value;
    }
  }
  assert.fail(`missing object field ${name}`);
}

function listElementFactKind(model: RsglSemanticModel, element: ListElementNode): string {
  return element.kind === "ListSpread"
    ? `spread:${factKind(model, element.expression)}`
    : factKind(model, element);
}

function onlyCall(module: RsglModule, name: string): CallExprNode {
  const calls: CallExprNode[] = [];
  walkRsglModule(module, {
    enterExpression(expression) {
      if (
        expression.kind === "CallExpr"
        && expression.callee.kind === "IdentifierExpr"
        && expression.callee.name.text === name
      ) {
        calls.push(expression);
      }
    }
  });
  assert.strictEqual(calls.length, 1, `expected one ${name} call`);
  return calls[0];
}

function onlyResourceLocation(module: RsglModule, value: string): ExprNode {
  const expressions: ExprNode[] = [];
  walkRsglModule(module, {
    enterExpression(expression) {
      if (expression.kind === "ResourceLocationExpr" && expression.value === value) {
        expressions.push(expression);
      }
    }
  });
  assert.strictEqual(expressions.length, 1, `expected one ${value} expression`);
  return expressions[0];
}

function fact(model: RsglSemanticModel, expression: ExprNode) {
  const resolved = model.resolvedExpectedTypes.get(expression);
  assert.ok(resolved, `missing resolved expected type for ${expression.kind}`);
  return resolved;
}

function factKind(model: RsglSemanticModel, expression: ExprNode): string {
  return fact(model, expression).kind;
}
