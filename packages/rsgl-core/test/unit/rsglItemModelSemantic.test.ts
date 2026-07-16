import * as assert from "node:assert";
import * as path from "node:path";
import {
  type ExprNode,
  type ItemModelProducerStmtNode,
  parseRsgl
} from "../../src/parser";
import {
  bindRsglModule,
  bindRsglProgram,
  formatType,
  type RsglSemanticModel
} from "../../src/semantic";

describe("RSGL recursive item-model semantics", () => {
  it("checks every recursive expression position and applies model reference sinks", () => {
    const source = [
      "let texture: TextureId = minecraft:item/not_a_model",
      "item checked {",
      "  select property missingProperty component missingComponent {",
      "    case missingWhen => condition property missingCondition {",
      "      on_true missingTrue + \"\"",
      "      on_false special base texture model { type: minecraft:trident, data: missingSpecialData }",
      "    } with { transformation: missingBranchTransform }",
      "    fallback texture",
      "  } with { transformation: missingRootTransform }",
      "}"
    ].join("\n");
    const module = parseRsgl(source);
    assert.deepStrictEqual(module.diagnostics, []);

    const model = bindRsglModule(module);
    const undefinedNames = model.diagnostics
      .filter(diagnostic => diagnostic.code === "rsgl.undefinedSymbol")
      .map(diagnostic => source.slice(diagnostic.range.start, diagnostic.range.end));
    assert.deepStrictEqual(undefinedNames, [
      "missingComponent",
      "missingWhen",
      "missingTrue",
      "missingSpecialData",
      "missingBranchTransform",
      "missingRootTransform"
    ]);
    assert.strictEqual(
      model.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.resourceIdKindMismatch").length,
      2
    );

    const producer = module.statements[1].kind === "ResourceDecl"
      ? module.statements[1].body.statements[0] as ItemModelProducerStmtNode
      : undefined;
    assert.ok(producer?.value.kind === "ItemModelSelect");
    const condition = producer.value.body.statements[0];
    assert.ok(condition.kind === "ItemSelectCase" && condition.model.kind === "ItemModelCondition");
    const special = condition.model.onFalse;
    assert.ok(special?.kind === "ItemModelSpecial");
    assert.strictEqual(expectedType(model, special.base), "ModelId");

    const fallback = producer.value.body.statements[1];
    assert.ok(fallback.kind === "ItemFallbackClause" && fallback.model.kind === "ItemModelExpr");
    assert.strictEqual(expectedType(model, fallback.model.expression), "ModelId | {} | Json");
  });

  it("checks all item property headers with the ResourceId contract", () => {
    const source = [
      "let selectProperty: ResourceId = \"display_context\"",
      "let rangeProperty = resource_id(\"damage\")",
      "let wrongProperty: Number = 1",
      "item typed_properties {",
      "  composite {",
      "    model select property selectProperty { fallback empty {} }",
      "    model range property rangeProperty { fallback empty {} }",
      "    model condition property wrongProperty {",
      "      on_true empty {}",
      "      on_false selected_item {}",
      "    }",
      "    model first_match {",
      "      when property shorthandProperty => empty {}",
      "      fallback selected_item {}",
      "    }",
      "  }",
      "}"
    ].join("\n");
    const module = parseRsgl(source);
    assert.deepStrictEqual(module.diagnostics, []);

    const model = bindRsglModule(module);
    assert.deepStrictEqual(
      model.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.message]),
      [["rsgl.typeMismatch", "Expected ResourceId, got Number."]]
    );

    const resource = module.statements[3];
    assert.ok(resource.kind === "ResourceDecl");
    const producer = resource.body.statements[0];
    assert.ok(producer.kind === "ItemModelProducerStmt" && producer.value.kind === "ItemModelComposite");
    const children = producer.value.body.statements;
    const select = children[0];
    const range = children[1];
    const condition = children[2];
    const firstMatch = children[3];
    assert.ok(select.kind === "ItemCompositeModel" && select.model.kind === "ItemModelSelect");
    assert.ok(range.kind === "ItemCompositeModel" && range.model.kind === "ItemModelRange");
    assert.ok(condition.kind === "ItemCompositeModel" && condition.model.kind === "ItemModelCondition");
    assert.ok(firstMatch.kind === "ItemCompositeModel" && firstMatch.model.kind === "ItemModelFirstMatch");
    const when = firstMatch.model.body.statements[0];
    assert.ok(when.kind === "ItemFirstMatchWhen");

    for (const property of [
      select.model.property,
      range.model.property,
      condition.model.property,
      when.property
    ]) {
      assert.strictEqual(expectedType(model, property), "ResourceId");
    }
    assert.strictEqual(
      model.diagnostics.some(diagnostic => diagnostic.code === "rsgl.undefinedSymbol"),
      false
    );
  });

  it("keeps explicit root model properties on the item-model reference contract", () => {
    const source = [
      "let texture: TextureId = minecraft:item/not_a_model",
      "item explicit { model: texture }"
    ].join("\n");
    const module = parseRsgl(source);
    assert.deepStrictEqual(module.diagnostics, []);

    const model = bindRsglModule(module);
    assert.deepStrictEqual(model.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.resourceIdKindMismatch"
    ]);
    const resource = module.statements[1];
    assert.ok(resource.kind === "ResourceDecl");
    const property = resource.body.statements[0];
    assert.ok(property.kind === "PropertyStmt");
    assert.strictEqual(expectedType(model, property.value), "ModelId | {} | Json");
  });

  it("keeps owner lets sequential and isolates for/if body bindings", () => {
    const source = [
      "item scoped {",
      "  select property minecraft:display_context {",
      "    let local = minecraft:item/local",
      "    for row in [{ when: \"gui\", model: minecraft:item/gui }] {",
      "      case row.when => row.model",
      "    }",
      "    if true {",
      "      let branch = minecraft:item/branch",
      "      case \"ground\" => branch",
      "    }",
      "    fallback local",
      "  }",
      "  outside_local: local + \"\"",
      "  outside_row: row + \"\"",
      "  outside_branch: branch + \"\"",
      "}"
    ].join("\n");
    const module = parseRsgl(source);
    assert.deepStrictEqual(module.diagnostics, []);

    const model = bindRsglModule(module);
    const undefinedNames = model.diagnostics
      .filter(diagnostic => diagnostic.code === "rsgl.undefinedSymbol")
      .map(diagnostic => source.slice(diagnostic.range.start, diagnostic.range.end));
    assert.deepStrictEqual(undefinedNames, ["local", "row", "branch"]);

    for (const name of ["local", "row", "branch"]) {
      const references = model.references.filter(reference => reference.name === name);
      assert.ok(references.some(reference => reference.symbol?.kind === "variable"));
      assert.ok(references.some(reference => reference.symbol === undefined));
    }
  });

  it("checks sequential control flow in range, composite, and first_match owners", () => {
    const source = [
      "item owners {",
      "  composite {",
      "    let base = minecraft:item/base",
      "    for modelId in [minecraft:item/a] { model modelId }",
      "    if true { model base }",
      "    model range property minecraft:damage {",
      "      let fallbackModel = minecraft:item/fallback",
      "      for row in [{ threshold: 0, model: minecraft:item/zero }] {",
      "        entry row.threshold => row.model",
      "      }",
      "      if true { frames [1] model `minecraft:item/frame_${index}_${frame}` }",
      "      fallback fallbackModel",
      "    }",
      "    model first_match {",
      "      let final = minecraft:item/final",
      "      for row in [{ value: \"a\", model: minecraft:item/a }] {",
      "        when property minecraft:component predicate \"custom\" value row.value => row.model",
      "      }",
      "      if true {",
      "        when property minecraft:component predicate \"custom\" value \"b\" => final",
      "      }",
      "      fallback final",
      "    }",
      "  }",
      "}"
    ].join("\n");
    const module = parseRsgl(source);
    assert.deepStrictEqual(module.diagnostics, []);

    const model = bindRsglModule(module);
    assert.deepStrictEqual(model.diagnostics, []);
    for (const name of ["base", "modelId", "fallbackModel", "row", "final", "frame"]) {
      assert.ok(
        model.references.some(reference => reference.name === name && reference.symbol),
        `expected a bound ${name} reference`
      );
    }
  });

  it("injects frame and index across the complete recursive frame model without leaking frame", () => {
    const source = [
      "item animated {",
      "  range property minecraft:custom_model_data {",
      "    frames [2] model condition property minecraft:using_item {",
      "      on_true `minecraft:item/active_${index}_${frame}`",
      "      on_false composite {",
      "        model `minecraft:item/index_${index}`",
      "        model `minecraft:item/frame_${frame}`",
      "      }",
      "    }",
      "    entry index => frame + \"\"",
      "    fallback minecraft:item/fallback",
      "  }",
      "}"
    ].join("\n");
    const module = parseRsgl(source);
    assert.deepStrictEqual(module.diagnostics, []);

    const model = bindRsglModule(module);
    const frameReferences = model.references.filter(reference => reference.name === "frame");
    assert.strictEqual(frameReferences.filter(reference => reference.symbol?.node?.kind === "ItemRangeFrames").length, 2);
    assert.strictEqual(frameReferences.filter(reference => reference.symbol === undefined).length, 1);
    assert.strictEqual(
      model.diagnostics.filter(diagnostic =>
        diagnostic.code === "rsgl.undefinedSymbol"
        && source.slice(diagnostic.range.start, diagnostic.range.end) === "frame"
      ).length,
      1
    );

    const indexReferences = model.references.filter(reference => reference.name === "index");
    assert.strictEqual(indexReferences.filter(reference => reference.symbol?.node?.kind === "ItemRangeFrames").length, 2);
    assert.strictEqual(indexReferences.filter(reference => reference.symbol?.kind === "builtin").length, 1);
  });

  it("records root, nested, and chained item-model uses with the itemModel caller", () => {
    const source = [
      "template leaf(value: ModelId) -> item_model { model value }",
      "template wrapper(value: ModelId) -> item_model {",
      "  let selected = value",
      "  if true { use leaf(selected) }",
      "}",
      "item root { use wrapper(minecraft:item/root) }",
      "item nested { composite { model use leaf(minecraft:item/nested) } }",
      "model block wrong { use leaf(minecraft:item/wrong) }",
      "item sectioned {",
      "  raw { use leaf(minecraft:item/hidden) }",
      "  model minecraft:item/sectioned",
      "}"
    ].join("\n");
    const module = parseRsgl(source);
    assert.deepStrictEqual(module.diagnostics, []);

    const model = bindRsglModule(module);
    const callerKinds = (model.templateUses ?? []).map(use =>
      use.callerContext?.kind === "resourceBody"
        ? `${use.callerContext.kind}:${use.callerContext.resourceKind}`
        : use.callerContext?.kind
    );
    assert.deepStrictEqual(callerKinds, [
      "itemModel",
      "itemModel",
      "itemModel",
      "resourceBody:model",
      "resourceBody:item"
    ]);
    assert.strictEqual(
      model.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.templateOutputDialectMismatch").length,
      2
    );
    assert.strictEqual(model.diagnostics.some(diagnostic => diagnostic.code === "rsgl.undefinedSymbol"), false);
  });

  it("links item-model dialects through a namespace re-export", () => {
    const root = path.resolve("item-model-reexport");
    const mainFile = path.join(root, "main.rsgl");
    const barrelFile = path.join(root, "barrel.rsgl");
    const leafFile = path.join(root, "leaf.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import * as catalog from \"./barrel.rsgl\"",
          "item linked { composite { model use catalog.leaf() } }"
        ].join("\n"))
      },
      {
        fileName: barrelFile,
        module: parseRsgl("export { leaf } from \"./leaf.rsgl\"")
      },
      {
        fileName: leafFile,
        module: parseRsgl([
          "template leaf() -> item_model { model minecraft:item/linked }",
          "export { leaf }"
        ].join("\n"))
      }
    ]);

    assert.strictEqual(program.fileDiagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.templateOutputDialectMismatch"
      || diagnostic.code === "rsgl.missingImportedMember"
      || diagnostic.code === "rsgl.missingExportedMember"
    ), false);
    const catalog = program.models.find(model => model.fileName === mainFile)?.scope.symbols.get("catalog");
    assert.strictEqual(catalog?.kind, "namespace");
  });

  it("adds qualified item-model uses to the cross-file recursion graph", () => {
    const root = path.resolve("item-model-recursion");
    const aFile = path.join(root, "a.rsgl");
    const bFile = path.join(root, "b.rsgl");
    const program = bindRsglProgram([
      {
        fileName: aFile,
        module: parseRsgl([
          "import * as b from \"./b.rsgl\"",
          "template a() -> item_model { use b.b() }",
          "export { a }"
        ].join("\n"))
      },
      {
        fileName: bFile,
        module: parseRsgl([
          "import * as a from \"./a.rsgl\"",
          "template b() -> item_model {",
          "  composite { model use a.a() }",
          "}",
          "export { b }"
        ].join("\n"))
      }
    ]);

    assert.strictEqual(
      program.fileDiagnostics.filter(diagnostic => diagnostic.code === "rsgl.templateRecursion").length,
      2
    );
    assert.strictEqual(program.fileDiagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.templateOutputDialectMismatch"
      || diagnostic.code === "rsgl.missingImportedMember"
    ), false);
  });
});

function expectedType(model: RsglSemanticModel, expression: ExprNode): string | undefined {
  const type = model.resolvedExpectedTypes.get(expression);
  return type ? formatType(type) : undefined;
}
