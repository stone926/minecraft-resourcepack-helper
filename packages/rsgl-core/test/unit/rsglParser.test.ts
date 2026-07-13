import * as assert from "node:assert";
import { parseRsgl } from "../../src/parser";
import { resourceKeywords } from "../../src/parser/keywords";
import { getLegacyResourceBodyDialectForStatement } from "../../src/parser/resourceBodyDialectRegistry";
import { rsglResourceKinds } from "../../src/resourceKinds";

describe("RSGL parser", () => {
  it("keeps resource keyword registry wired into the parser", () => {
    assert.deepStrictEqual([...resourceKeywords], [...rsglResourceKinds]);
    for (const kind of rsglResourceKinds) {
      const source = kind === "model"
        ? "model block example {}"
        : kind === "pack" ? "pack {}" : `${kind} example {}`;
      const module = parseRsgl(source);
      assert.deepStrictEqual(module.diagnostics, []);
      assert.strictEqual(module.statements[0].kind, "ResourceDecl");
      if (module.statements[0].kind === "ResourceDecl") {
        assert.strictEqual(module.statements[0].resourceKind, kind);
      }
    }
  });

  it("parses a representative experimental module without diagnostics", () => {
    const module = parseRsgl([
      "target java format [88, 0]",
      "namespace minecraft",
      "import \"./tables/woods.rsgl\"",
      "model block acacia_planks {",
      "  parent minecraft:block/cube_all",
      "  textures {",
      "    all: minecraft:block/acacia_planks",
      "  }",
      "}",
      "use stairs(id: acacia_stairs)"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(module.statements.length, 5);
    assert.deepStrictEqual(module.statements.map(statement => statement.kind), [
      "TargetDecl",
      "NamespaceDecl",
      "ImportDecl",
      "ResourceDecl",
      "UseDecl"
    ]);

    const model = module.statements[3];
    assert.strictEqual(model.kind, "ResourceDecl");
    assert.strictEqual(model.resourceKind, "model");
    assert.strictEqual(model.subtype?.text, "block");
    assert.strictEqual(model.body.statements[0].kind, "PropertyStmt");
  });

  it("parses numeric and quoted resource body property keys", () => {
    const module = parseRsgl([
      "model block numbered_textures {",
      "  textures {",
      "    0: minecraft:block/zero",
      "    \"1\": minecraft:block/one",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const model = module.statements[0];
    assert.strictEqual(model.kind, "ResourceDecl");
    if (model.kind !== "ResourceDecl") {
      return;
    }
    const textures = model.body.statements[0];
    assert.strictEqual(textures.kind, "SectionStmt");
    assert.deepStrictEqual(
      textures.kind === "SectionStmt"
        ? textures.body?.statements.map(statement => statement.kind === "PropertyStmt" ? statement.name.text : "")
        : [],
      ["0", "1"]
    );
  });

  it("parses model geometry DSL statements", () => {
    const module = parseRsgl([
      "model block cauldron_wall {",
      "  texture wall minecraft:block/cauldron_side",
      "  box \"north wall\" from [2, 3, 0] to [14, 16, 2] rotation { origin: [8, 8, 8], axis: y, angle: 0 } {",
      "    all texture \"#wall\"",
      "    north cullface north uv [2, 0, 14, 13]",
      "    shade false",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const model = module.statements[0];
    assert.strictEqual(model.kind, "ResourceDecl");
    if (model.kind !== "ResourceDecl") {
      return;
    }
    const box = model.body.statements[1];
    assert.strictEqual(box.kind, "ModelElementStmt");
    if (box.kind !== "ModelElementStmt") {
      return;
    }
    assert.strictEqual(box.elementKind, "box");
    assert.strictEqual(box.label?.kind, "StringLiteral");
    assert.strictEqual(box.from?.kind, "ListExpr");
    assert.strictEqual(box.to?.kind, "ListExpr");
    assert.strictEqual(box.properties.map(property => property.name.text).join(","), "rotation,shade");
    assert.deepStrictEqual(box.faces.map(face => face.target.text), ["all", "north"]);
  });

  it("derives model element kinds and clauses from the geometry syntax registry", () => {
    const module = parseRsgl([
      "model block shifted_element {",
      "  element from [0, 0, 0] to [16, 16, 16] light_emission 7 translate [1, 2, 3] {",
      "    face east texture \"#all\" tintindex 2",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const model = module.statements[0];
    assert.strictEqual(model.kind, "ResourceDecl");
    if (model.kind !== "ResourceDecl") {
      return;
    }
    const element = model.body.statements[0];
    assert.strictEqual(element.kind, "ModelElementStmt");
    if (element.kind !== "ModelElementStmt") {
      return;
    }

    assert.strictEqual(element.elementKind, "element");
    assert.strictEqual(element.from?.kind, "ListExpr");
    assert.strictEqual(element.to?.kind, "ListExpr");
    assert.deepStrictEqual(
      element.properties.map(property => property.name.text),
      ["light_emission", "translate"]
    );
    assert.deepStrictEqual(element.faces.map(face => face.target.text), ["east"]);
    assert.deepStrictEqual(
      element.faces[0]?.properties.map(property => property.name.text),
      ["texture", "tintindex"]
    );
  });

  it("keeps guarded domain statement words available as explicit JSON fields", () => {
    const module = parseRsgl([
      "atlas minecraft:blocks {",
      "  directory: \"block\"",
      "  paletted_permutations: {}",
      "}",
      "equipment minecraft:leather {",
      "  layer: []",
      "}",
      "model block explicit_fields {",
      "  texture: \"plain\"",
      "  box: {}",
      "  element = 1",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const resources = module.statements.filter(statement => statement.kind === "ResourceDecl");
    assert.deepStrictEqual(resources.map(resource => resource.body.statements.map(statement => statement.kind)), [
      ["PropertyStmt", "PropertyStmt"],
      ["PropertyStmt"],
      ["PropertyStmt", "PropertyStmt", "PropertyStmt"]
    ]);
  });

  it("recovers from a malformed domain statement before parsing the next field", () => {
    const module = parseRsgl([
      "atlas minecraft:blocks {",
      "  directory unexpected clause",
      "  sources: []",
      "}"
    ].join("\n"));

    assert.ok(module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.expectedAtlasDirectoryClause"));
    const atlas = module.statements[0];
    assert.strictEqual(atlas.kind, "ResourceDecl");
    if (atlas.kind !== "ResourceDecl") {
      return;
    }
    assert.deepStrictEqual(atlas.body.statements.map(statement => statement.kind), [
      "AtlasDirectoryStmt",
      "PropertyStmt"
    ]);
  });

  it("parses export declarations", () => {
    const module = parseRsgl([
      "export { cube as cubeModel, woods }",
      "export { cubeModel } from \"./templates.rsgl\"",
      "export * from \"./tables.rsgl\""
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.deepStrictEqual(module.statements.map(statement => statement.kind), [
      "ExportDecl",
      "ExportDecl",
      "ExportDecl"
    ]);
    const localExport = module.statements[0];
    assert.strictEqual(localExport.kind, "ExportDecl");
    assert.strictEqual(localExport.source, null);
    assert.strictEqual(localExport.specifiers[0].local.text, "cube");
    assert.strictEqual(localExport.specifiers[0].exported.text, "cubeModel");
    const reExport = module.statements[1];
    assert.strictEqual(reExport.kind, "ExportDecl");
    assert.strictEqual(reExport.source?.value, "./templates.rsgl");
    const exportAll = module.statements[2];
    assert.strictEqual(exportAll.kind, "ExportDecl");
    assert.strictEqual(exportAll.exportAll, true);
  });

  it("parses resource body template declarations", () => {
    const module = parseRsgl([
      "template cubeFields(parentModel: ModelId, texture: TextureId) {",
      "  parent parentModel",
      "  textures { all: texture }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(module.statements.length, 1);
    const fragment = module.statements[0];
    assert.strictEqual(fragment.kind, "TemplateDecl");
    if (fragment.kind !== "TemplateDecl") {
      throw new Error("Expected template declaration.");
    }
    assert.strictEqual(fragment.name?.text, "cubeFields");
    assert.deepStrictEqual(fragment.parameters.map(parameter => parameter.name?.text), ["parentModel", "texture"]);
    assert.strictEqual(fragment.outputSyntax, "noArrow");
    assert.strictEqual(fragment.declaredOutputDialect, undefined);
    assert.strictEqual(fragment.body.kind, "ResourceBody");
    assert.deepStrictEqual(fragment.body.statements.map(statement => statement.kind), ["PropertyStmt", "SectionStmt"]);
  });

  it("parses explicit template output dialects and preserves them through control flow", () => {
    const module = parseRsgl([
      "template hopperBowl(texture: TextureId) -> model {",
      "  for offset in [0, 1] {",
      "    if true {",
      "      element from [0, 0, 0] to [16, 4, 16] { face up texture texture }",
      "    }",
      "  }",
      "}",
      "template stateSequence(model: ModelId) -> variants {",
      "  for state in [off, on] { [powered=state] -> { model: model } }",
      "}",
      "template connected(model: ModelId) -> multipart {",
      "  if true { when { north: true } apply { model: model } }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const [modelTemplate, variantsTemplate, multipartTemplate] = module.statements;
    assert.strictEqual(modelTemplate.kind, "TemplateDecl");
    assert.strictEqual(variantsTemplate.kind, "TemplateDecl");
    assert.strictEqual(multipartTemplate.kind, "TemplateDecl");
    if (
      modelTemplate.kind !== "TemplateDecl"
      || variantsTemplate.kind !== "TemplateDecl"
      || multipartTemplate.kind !== "TemplateDecl"
    ) {
      throw new Error("Expected template declarations.");
    }

    assert.deepStrictEqual(
      [modelTemplate, variantsTemplate, multipartTemplate].map(template => [
        template.outputSyntax,
        template.declaredOutputDialect,
        template.body.kind
      ]),
      [
        ["explicitArrow", "model", "ResourceBody"],
        ["explicitArrow", "variants", "VariantBody"],
        ["explicitArrow", "multipart", "MultipartBody"]
      ]
    );
    const modelLoop = modelTemplate.body.kind === "ResourceBody" ? modelTemplate.body.statements[0] : undefined;
    assert.strictEqual(modelLoop?.kind, "ForStmt");
    if (modelLoop?.kind === "ForStmt" && modelLoop.body.kind === "ResourceBody") {
      const branch = modelLoop.body.statements[0];
      assert.strictEqual(branch.kind, "IfStmt");
      if (branch.kind === "IfStmt" && branch.thenBody.kind === "ResourceBody") {
        assert.strictEqual(branch.thenBody.statements[0]?.kind, "ModelElementStmt");
      }
    }
  });

  it("rejects non-public template output dialects", () => {
    const module = parseRsgl("template old() -> blockstate {}");

    assert.ok(module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidTemplateOutputDialect"));
    const template = module.statements[0];
    assert.strictEqual(template.kind, "TemplateDecl");
    if (template.kind === "TemplateDecl") {
      assert.strictEqual(template.outputSyntax, "explicitArrow");
      assert.strictEqual(template.declaredOutputDialect, undefined);
    }
  });

  it("keeps explicit template body kinds during incomplete-editor recovery", () => {
    const model = parseRsgl("template geometry() -> model");
    const variants = parseRsgl("template states() -> variants");
    const multipart = parseRsgl("template parts() -> multipart");

    assert.strictEqual(model.statements[0].kind === "TemplateDecl" && model.statements[0].body.kind, "ResourceBody");
    assert.strictEqual(variants.statements[0].kind === "TemplateDecl" && variants.statements[0].body.kind, "VariantBody");
    assert.strictEqual(multipart.statements[0].kind === "TemplateDecl" && multipart.statements[0].body.kind, "MultipartBody");
    assert.ok(model.diagnostics.some(item => item.code === "rsgl.expectedResourceBody"));
    assert.ok(variants.diagnostics.some(item => item.code === "rsgl.expectedVariantBody"));
    assert.ok(multipart.diagnostics.some(item => item.code === "rsgl.expectedMultipartBody"));
  });

  it("retains specialized model AST for legacy no-arrow compatibility", () => {
    const module = parseRsgl([
      "template bowl() {",
      "  if true { element from [0, 0, 0] to [16, 4, 16] { face up texture \"#side\" } }",
      "}"
    ].join("\n"));
    const template = module.statements[0];

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(template.kind, "TemplateDecl");
    if (template.kind === "TemplateDecl" && template.body.kind === "ResourceBody") {
      const branch = template.body.statements[0];
      assert.strictEqual(branch.kind, "IfStmt");
      if (branch.kind === "IfStmt" && branch.thenBody.kind === "ResourceBody") {
        assert.strictEqual(branch.thenBody.statements[0]?.kind, "ModelElementStmt");
      }
    }
  });

  it("recognizes multiline model impl resources without promoting bare item model fields", () => {
    const module = parseRsgl([
      "template suspiciousModel(type: String, file: String, tex: String) {",
      "  model block `suspicious_${type}/${file}`",
      "  impl minecraft:block/cube_all(all: `minecraft:block/suspicious_${type}/${tex}`) {",
      "    textures {",
      "      if file == \"dusted_0\" {",
      "        particle: `minecraft:block/suspicious_${type}_0`",
      "      }",
      "    }",
      "  }",
      "}",
      "template itemBody() {",
      "  model block",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const [resourceTemplate, itemTemplate] = module.statements;
    assert.strictEqual(resourceTemplate.kind, "TemplateDecl");
    assert.strictEqual(itemTemplate.kind, "TemplateDecl");
    if (resourceTemplate.kind !== "TemplateDecl" || itemTemplate.kind !== "TemplateDecl") {
      assert.fail("Expected template declarations.");
      return;
    }

    assert.strictEqual(resourceTemplate.body.kind, "Block");
    if (resourceTemplate.body.kind === "Block") {
      const model = resourceTemplate.body.statements[0];
      assert.strictEqual(model.kind, "ResourceDecl");
      if (model.kind === "ResourceDecl") {
        assert.strictEqual(model.resourceKind, "model");
        assert.strictEqual(model.subtype?.text, "block");
        assert.strictEqual(model.impl?.kind, "CallExpr");
      }
    }

    assert.strictEqual(itemTemplate.body.kind, "ResourceBody");
    if (itemTemplate.body.kind === "ResourceBody") {
      const modelField = itemTemplate.body.statements[0];
      assert.strictEqual(modelField.kind, "PropertyStmt");
      if (modelField.kind === "PropertyStmt") {
        assert.strictEqual(modelField.name.text, "model");
        assert.strictEqual(modelField.value.kind, "IdentifierExpr");
      }
    }
  });

  it("retains legacy resource-body dialects through leading control flow", () => {
    const module = parseRsgl([
      "template genericFields(values: Json) {",
      "  for value in values { custom value }",
      "}",
      "template itemBody() {",
      "  if true { range property minecraft:compass { frames 0..1 model minecraft:item/compass } }",
      "}",
      "template packBody() {",
      "  if true { formats min [88, 0] max [9999, 0] }",
      "}",
      "template atlasBody() {",
      "  for source in [\"block\"] { directory source source prefix \"block/\" }",
      "}",
      "template equipmentBody() {",
      "  if true { layer humanoid texture minecraft:iron }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const expectedNestedKinds = [
      "PropertyStmt",
      "ItemRangeStmt",
      "PackFormatsStmt",
      "AtlasDirectoryStmt",
      "EquipmentLayerStmt"
    ];
    module.statements.forEach((statement, index) => {
      assert.strictEqual(statement.kind, "TemplateDecl");
      if (statement.kind !== "TemplateDecl") {
        return;
      }
      assert.strictEqual(statement.body.kind, "ResourceBody");
      if (statement.body.kind !== "ResourceBody") {
        return;
      }
      const control = statement.body.statements[0];
      assert.ok(control.kind === "ForStmt" || control.kind === "IfStmt");
      const nestedBody = control.kind === "ForStmt" ? control.body : control.thenBody;
      assert.strictEqual(nestedBody.kind, "ResourceBody");
      if (nestedBody.kind === "ResourceBody") {
        assert.strictEqual(nestedBody.statements[0]?.kind, expectedNestedKinds[index]);
      }
    });
  });

  it("uses explicit property syntax to escape every specialized body grammar", () => {
    const module = parseRsgl([
      "json \"assets/minecraft/custom/escaped.json\" {",
      "  range: 1",
      "  variants: { enabled: true }",
      "  textures: {}",
      "  if: true",
      "}",
      "item escaped { range: 2 }",
      "blockstate escaped { variants: {} }"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.deepStrictEqual(module.statements.map(statement =>
      statement.kind === "ResourceDecl"
        ? statement.body.statements.map(item => item.kind)
        : []
    ), [
      ["PropertyStmt", "PropertyStmt", "PropertyStmt", "PropertyStmt"],
      ["PropertyStmt"],
      ["PropertyStmt"]
    ]);
  });

  it("classifies overlay-only pack templates and diagnoses mixed legacy dialects", () => {
    const overlay = parseRsgl("template overlayBody() { overlay \"future\" {} }");
    const overlayTemplate = overlay.statements[0];

    assert.deepStrictEqual(overlay.diagnostics, []);
    assert.strictEqual(overlayTemplate.kind, "TemplateDecl");
    if (overlayTemplate.kind === "TemplateDecl" && overlayTemplate.body.kind === "ResourceBody") {
      assert.strictEqual(overlayTemplate.body.statements[0]?.kind, "PackOverlayStmt");
    } else {
      assert.fail("Expected an overlay-only legacy pack ResourceBody.");
    }

    const mixed = parseRsgl([
      "template mixedBody() {",
      "  texture all minecraft:block/stone",
      "  layer humanoid",
      "}"
    ].join("\n"));
    const mixedTemplate = mixed.statements[0];

    assert.ok(mixed.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.conflictingLegacyTemplateBodyDialects"
    ));
    assert.strictEqual(mixedTemplate.kind, "TemplateDecl");
    if (mixedTemplate.kind === "TemplateDecl" && mixedTemplate.body.kind === "ResourceBody") {
      assert.deepStrictEqual(
        mixedTemplate.body.statements.map(statement => statement.kind),
        ["ModelTextureStmt", "PropertyStmt"]
      );
    }
  });

  it("retains node-aware mcmeta evidence in the legacy dialect registry", () => {
    const module = parseRsgl("template textureMetadata() { texture { blur: true } }");
    const template = module.statements[0];

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(template.kind, "TemplateDecl");
    if (template.kind !== "TemplateDecl" || template.body.kind !== "ResourceBody") {
      assert.fail("Expected a legacy mcmeta ResourceBody.");
      return;
    }
    const texture = template.body.statements[0];
    assert.strictEqual(texture.kind, "SectionStmt");
    assert.strictEqual(getLegacyResourceBodyDialectForStatement(texture), "mcmeta");
  });

  it("rejects legacy fragment declarations", () => {
    const module = parseRsgl("fragment cubeFields(value: Json) { key: value }");

    assert.ok(module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unexpectedToken"));
  });

  it("rejects legacy bare sugar declarations", () => {
    const blockstate = parseRsgl("stairs acacia_stairs");
    const batch = parseRsgl("cube_all [stone]");

    assert.ok(blockstate.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unexpectedToken"));
    assert.ok(batch.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unexpectedToken"));
  });

  it("parses item range and select statements", () => {
    const module = parseRsgl([
      "item compass {",
      "  range property minecraft:compass target spawn wobble true {",
      "    frames 0..2 model `minecraft:item/compass_${pad(index, 2)}`",
      "    fallback minecraft:item/compass_00",
      "  }",
      "}",
      "item potion {",
      "  select property minecraft:potion_contents component minecraft:potion_contents {",
      "    case \"minecraft:healing\" -> minecraft:item/potion_healing",
      "    fallback minecraft:item/potion",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const compass = module.statements[0];
    const potion = module.statements[1];
    assert.strictEqual(compass.kind, "ResourceDecl");
    assert.strictEqual(potion.kind, "ResourceDecl");
    if (compass.kind !== "ResourceDecl" || potion.kind !== "ResourceDecl") {
      throw new Error("Expected item resource declarations.");
    }
    assert.deepStrictEqual(compass.body.statements.map(statement => statement.kind), ["ItemRangeStmt"]);
    assert.deepStrictEqual(potion.body.statements.map(statement => statement.kind), ["ItemSelectStmt"]);
  });

  it("parses item condition and composite statements", () => {
    const module = parseRsgl([
      "item bow {",
      "  condition property minecraft:using_item {",
      "    on_true minecraft:item/bow_pulling",
      "    on_false minecraft:item/bow",
      "  }",
      "}",
      "item layered {",
      "  composite {",
      "    model minecraft:item/base",
      "    model { type: minecraft:model, model: minecraft:item/overlay }",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const bow = module.statements[0];
    const layered = module.statements[1];
    assert.strictEqual(bow.kind, "ResourceDecl");
    assert.strictEqual(layered.kind, "ResourceDecl");
    if (bow.kind !== "ResourceDecl" || layered.kind !== "ResourceDecl") {
      throw new Error("Expected item resource declarations.");
    }
    assert.deepStrictEqual(bow.body.statements.map(statement => statement.kind), ["ItemConditionStmt"]);
    assert.deepStrictEqual(layered.body.statements.map(statement => statement.kind), ["ItemCompositeStmt"]);
  });

  it("parses item special, empty, and selected item statements", () => {
    const module = parseRsgl([
      "item shield {",
      "  special base minecraft:item/shield model { type: minecraft:shield }",
      "}",
      "item hidden {",
      "  empty",
      "}",
      "item bundle {",
      "  selected_item",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const [shield, hidden, bundle] = module.statements;
    assert.strictEqual(shield.kind, "ResourceDecl");
    assert.strictEqual(hidden.kind, "ResourceDecl");
    assert.strictEqual(bundle.kind, "ResourceDecl");
    if (shield.kind !== "ResourceDecl" || hidden.kind !== "ResourceDecl" || bundle.kind !== "ResourceDecl") {
      throw new Error("Expected item resource declarations.");
    }
    assert.deepStrictEqual(shield.body.statements.map(statement => statement.kind), ["ItemSpecialStmt"]);
    assert.deepStrictEqual(hidden.body.statements.map(statement => statement.kind), ["ItemEmptyStmt"]);
    assert.deepStrictEqual(bundle.body.statements.map(statement => statement.kind), ["ItemSelectedItemStmt"]);
  });

  it("parses overlay declarations", () => {
    const module = parseRsgl([
      "overlay \"future\" format [90, 0]..[91, 0] {",
      "  model block stone {",
      "    parent minecraft:block/cube_all",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(module.statements.length, 1);
    const overlay = module.statements[0];
    assert.strictEqual(overlay.kind, "OverlayDecl");
    if (overlay.kind !== "OverlayDecl") {
      throw new Error("Expected overlay declaration.");
    }
    assert.strictEqual(overlay.directory.kind, "StringLiteral");
    assert.strictEqual(overlay.formatRange?.kind, "RangeExpr");
    assert.deepStrictEqual(overlay.body.statements.map(statement => statement.kind), ["ResourceDecl"]);
  });

  it("parses pack metadata sugar statements", () => {
    const module = parseRsgl([
      "pack {",
      "  formats min [88, 0] max [9999, 0]",
      "  overlay \"format_75\" {",
      "    formats min [75, 0] max [87, 9999]",
      "  }",
      "  filter {",
      "    block namespace \"minecraft\" path \"textures/block/stone.*\"",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const pack = module.statements[0];
    assert.strictEqual(pack.kind, "ResourceDecl");
    if (pack.kind !== "ResourceDecl") {
      throw new Error("Expected pack resource declaration.");
    }
    assert.deepStrictEqual(pack.body.statements.map(statement => statement.kind), [
      "PackFormatsStmt",
      "PackOverlayStmt",
      "SectionStmt"
    ]);
    const overlay = pack.body.statements[1];
    assert.strictEqual(overlay.kind, "PackOverlayStmt");
    if (overlay.kind !== "PackOverlayStmt") {
      throw new Error("Expected pack overlay statement.");
    }
    assert.deepStrictEqual(overlay.body.statements.map(statement => statement.kind), ["PackFormatsStmt"]);
    const filter = pack.body.statements[2];
    assert.strictEqual(filter.kind, "SectionStmt");
    assert.deepStrictEqual(filter.kind === "SectionStmt" ? filter.body?.statements.map(statement => statement.kind) : [], ["PackFilterBlockStmt"]);
  });

  it("parses atlas source sugar statements", () => {
    const module = parseRsgl([
      "atlas minecraft:blocks {",
      "  directory source \"block\" prefix \"block/\"",
      "  filter namespace \"minecraft\" path \"block/.*_debug\"",
      "  sources [",
      "    { type: minecraft:single, resource: minecraft:block/stone }",
      "  ]",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const atlas = module.statements[0];
    assert.strictEqual(atlas.kind, "ResourceDecl");
    if (atlas.kind !== "ResourceDecl") {
      throw new Error("Expected atlas resource declaration.");
    }
    assert.deepStrictEqual(atlas.body.statements.map(statement => statement.kind), [
      "AtlasDirectoryStmt",
      "AtlasFilterStmt",
      "SectionStmt"
    ]);
  });

  it("parses equipment layer sugar statements", () => {
    const module = parseRsgl([
      "equipment minecraft:leather {",
      "  layer humanoid texture minecraft:leather dyeable color 0xA06500",
      "  layer humanoid texture minecraft:leather_overlay use_player_texture",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const equipment = module.statements[0];
    assert.strictEqual(equipment.kind, "ResourceDecl");
    if (equipment.kind !== "ResourceDecl") {
      throw new Error("Expected equipment resource declaration.");
    }
    assert.deepStrictEqual(equipment.body.statements.map(statement => statement.kind), [
      "EquipmentLayerStmt",
      "EquipmentLayerStmt"
    ]);
  });

  it("parses base and every merge mode with object and expression fragments", () => {
    const source = [
      "model block patched {",
      "  base \"./base.json\"",
      "  merge { parent: minecraft:block/cube_all }",
      "  merge deep deepFragment",
      "  merge strict { parent: minecraft:block/stone }",
      "  merge upsert { display: {} }",
      "  merge append { layers: [] }",
      "  merge (deep)",
      "}"
    ].join("\n");
    const module = parseRsgl(source);

    assert.deepStrictEqual(module.diagnostics, []);
    const model = module.statements[0];
    assert.strictEqual(model.kind, "ResourceDecl");
    if (model.kind !== "ResourceDecl") {
      throw new Error("Expected model resource declaration.");
    }
    assert.deepStrictEqual(model.body.statements.map(statement => statement.kind), [
      "BaseStmt",
      "MergeStmt",
      "MergeStmt",
      "MergeStmt",
      "MergeStmt",
      "MergeStmt",
      "MergeStmt"
    ]);
    const base = model.body.statements[0];
    assert.strictEqual(base.kind === "BaseStmt" ? base.path.kind : "", "StringLiteral");
    const merges = model.body.statements.slice(1);
    assert.deepStrictEqual(
      merges.map(statement => statement.kind === "MergeStmt" ? statement.mode : undefined),
      ["shallow", "deep", "strict", "upsert", "append", "shallow"]
    );
    const deep = merges[1];
    assert.strictEqual(deep.kind, "MergeStmt");
    if (deep.kind === "MergeStmt") {
      assert.strictEqual(deep.modifier?.text, "deep");
      assert.strictEqual(source.slice(deep.modifier?.range.start, deep.modifier?.range.end), "deep");
      assert.strictEqual(deep.value.kind, "IdentifierExpr");
    }
    const parenthesized = merges[5];
    assert.strictEqual(parenthesized.kind === "MergeStmt" ? parenthesized.modifier : undefined, undefined);
  });

  it("reports base phase violations while preserving parsed statements", () => {
    const module = parseRsgl([
      "model block patched {",
      "  parent minecraft:block/cube_all",
      "  base \"./first.json\"",
      "  base \"./second.json\"",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.baseMustPrecedeBody",
      "rsgl.duplicateBase"
    ]);
    const model = module.statements[0];
    assert.strictEqual(model.kind, "ResourceDecl");
    if (model.kind === "ResourceDecl") {
      assert.deepStrictEqual(model.body.statements.map(statement => statement.kind), [
        "PropertyStmt",
        "BaseStmt",
        "BaseStmt"
      ]);
    }
  });

  it("rejects base outside concrete resource roots", () => {
    const module = parseRsgl([
      "template seeded() {",
      "  base \"./template.json\"",
      "}",
      "model block nested {",
      "  textures {",
      "    base \"./textures.json\"",
      "  }",
      "  if true {",
      "    base \"./branch.json\"",
      "  }",
      "}",
      "pack {",
      "  overlay \"future\" {",
      "    base \"./overlay.json\"",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.baseInvalidContext",
      "rsgl.baseInvalidContext",
      "rsgl.baseInvalidContext",
      "rsgl.baseInvalidContext"
    ]);
  });

  it("allows base in concrete resource roots nested in top-level control flow", () => {
    const module = parseRsgl([
      "if true {",
      "  model block conditional {",
      "    base \"./conditional.json\"",
      "  }",
      "}",
      "for id in [stone] {",
      "  item id {",
      "    base \"./item.json\"",
      "  }",
      "}"
    ].join("\n"));

    assert.strictEqual(module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.baseInvalidContext"), false);
  });

  it("rejects removed merge statements without parsing them as JSON properties", () => {
    const module = parseRsgl([
      "model block legacy {",
      "  raw_json { parent: minecraft:block/cube_all }",
      "  raw_json(\"{\\\"ambientocclusion\\\":false}\")",
      "  raw_json_file(\"./base.json\")",
      "  override { parent: minecraft:block/stone }",
      "  override create { display: {} }",
      "  append { layers: [] }",
      "  deep { textures: {} }",
      "  strict { parent: minecraft:block/stone }",
      "  upsert { display: {} }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.removedMergeSyntax",
      "rsgl.removedMergeSyntax",
      "rsgl.removedMergeSyntax",
      "rsgl.removedMergeSyntax",
      "rsgl.removedMergeSyntax",
      "rsgl.removedMergeSyntax",
      "rsgl.removedMergeSyntax",
      "rsgl.removedMergeSyntax",
      "rsgl.removedMergeSyntax"
    ]);
    const model = module.statements[0];
    assert.strictEqual(model.kind, "ResourceDecl");
    if (model.kind === "ResourceDecl") {
      assert.deepStrictEqual(model.body.statements.map(statement => statement.kind), [
        "UnknownStmt",
        "UnknownStmt",
        "UnknownStmt",
        "UnknownStmt",
        "UnknownStmt",
        "UnknownStmt",
        "UnknownStmt",
        "UnknownStmt",
        "UnknownStmt"
      ]);
    }
  });

  it("keeps merge-related words available as explicit JSON property names", () => {
    const module = parseRsgl([
      "json \"assets/example.json\" {",
      "  base: 1",
      "  merge: 2",
      "  deep: 3",
      "  strict: 4",
      "  upsert: 5",
      "  append: 6",
      "  raw_json: 7",
      "  raw_json_file: 8",
      "  override: 9",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const resource = module.statements[0];
    assert.strictEqual(resource.kind, "ResourceDecl");
    if (resource.kind === "ResourceDecl") {
      assert.ok(resource.body.statements.every(statement => statement.kind === "PropertyStmt"));
    }
  });

  it("builds expression ASTs for ranges, calls, members, conditionals, and template interpolation", () => {
    const source = [
      "let frames = seq(`minecraft:item/clock_${pad(index, 2)}`)",
      "let powered = state.powered ? 1..4 : [0, 1]"
    ].join("\n");
    const module = parseRsgl(source);

    assert.deepStrictEqual(module.diagnostics, []);
    const frames = module.statements[0];
    assert.strictEqual(frames.kind, "LetDecl");
    assert.strictEqual(frames.value.kind, "CallExpr");
    const template = frames.value.args[0].value;
    assert.strictEqual(template.kind, "TemplateStringExpr");
    assert.strictEqual(template.parts.some(part => part.kind === "expression" && part.expression.kind === "CallExpr"), true);
    const interpolation = template.parts.find(part => part.kind === "expression");
    assert.ok(interpolation?.kind === "expression");
    assert.strictEqual(interpolation.expression.kind, "CallExpr");
    if (interpolation.expression.kind !== "CallExpr") {
      throw new Error("Expected template interpolation call expression.");
    }
    const callee = interpolation.expression.callee;
    const indexArg = interpolation.expression.args[0].value;
    assert.strictEqual(callee.kind, "IdentifierExpr");
    assert.strictEqual(indexArg.kind, "IdentifierExpr");
    assert.strictEqual(source.slice(callee.range.start, callee.range.end), "pad");
    assert.strictEqual(source.slice(indexArg.range.start, indexArg.range.end), "index");

    const powered = module.statements[1];
    assert.strictEqual(powered.kind, "LetDecl");
    assert.strictEqual(powered.value.kind, "ConditionalExpr");
    assert.strictEqual(powered.value.condition.kind, "MemberExpr");
    assert.strictEqual(powered.value.whenTrue.kind, "RangeExpr");
    assert.strictEqual(powered.value.whenFalse.kind, "ListExpr");
  });

  it("keeps state key and model apply sugar as expression AST nodes", () => {
    const module = parseRsgl([
      "blockstate minecraft:example {",
      "  variants {",
      "    [facing=west half=bottom] -> @block/example y=90 uvlock",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const blockstate = module.statements[0];
    assert.strictEqual(blockstate.kind, "ResourceDecl");
    const variants = blockstate.body.statements[0];
    assert.strictEqual(variants.kind, "VariantsSection");
    const entry = variants.entries[0];
    assert.strictEqual(entry.kind, "VariantEntry");
    if (entry.kind !== "VariantEntry") {
      throw new Error("Expected variant entry.");
    }
    assert.strictEqual(entry.state.kind, "StateKeySugar");
    assert.strictEqual(entry.value.kind, "ModelApplySugar");
    assert.strictEqual(entry.value.properties.length, 2);
  });

  it("parses multipart entries with structured when/apply nodes", () => {
    const module = parseRsgl([
      "blockstate minecraft:oak_fence {",
      "  multipart {",
      "    apply { model: minecraft:block/oak_fence_post }",
      "    when { north: true } apply { model: minecraft:block/oak_fence_side }",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const blockstate = module.statements[0];
    assert.strictEqual(blockstate.kind, "ResourceDecl");
    const multipart = blockstate.body.statements[0];
    assert.strictEqual(multipart.kind, "MultipartSection");
    assert.strictEqual(multipart.entries.length, 2);
    const firstEntry = multipart.entries[0];
    const secondEntry = multipart.entries[1];
    assert.strictEqual(firstEntry.kind, "MultipartEntry");
    assert.strictEqual(secondEntry.kind, "MultipartEntry");
    if (firstEntry.kind !== "MultipartEntry" || secondEntry.kind !== "MultipartEntry") {
      throw new Error("Expected multipart entries.");
    }
    assert.strictEqual(firstEntry.when, undefined);
    assert.strictEqual(secondEntry.when?.kind, "ObjectExpr");
    assert.strictEqual(secondEntry.apply.kind, "ObjectExpr");
  });

  it("parses control flow inside blockstate sections", () => {
    const module = parseRsgl([
      "blockstate minecraft:lamp {",
      "  variants {",
      "    for state in product({ facing: [north, east], powered: [false, true] }) {",
      "      [facing=state.facing powered=state.powered] -> { model: `minecraft:block/lamp_${state.facing}` }",
      "    }",
      "  }",
      "}",
      "blockstate minecraft:fence {",
      "  multipart {",
      "    if true {",
      "      apply { model: minecraft:block/fence_post }",
      "    }",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const lamp = module.statements[0];
    assert.strictEqual(lamp.kind, "ResourceDecl");
    const variants = lamp.body.statements[0];
    assert.strictEqual(variants.kind, "VariantsSection");
    const forEntry = variants.entries[0];
    assert.strictEqual(forEntry.kind, "ForStmt");
    if (forEntry.kind !== "ForStmt") {
      throw new Error("Expected for statement.");
    }
    assert.strictEqual(forEntry.body.kind, "VariantBody");

    const fence = module.statements[1];
    assert.strictEqual(fence.kind, "ResourceDecl");
    const multipart = fence.body.statements[0];
    assert.strictEqual(multipart.kind, "MultipartSection");
    const ifEntry = multipart.entries[0];
    assert.strictEqual(ifEntry.kind, "IfStmt");
    if (ifEntry.kind !== "IfStmt") {
      throw new Error("Expected if statement.");
    }
    assert.strictEqual(ifEntry.thenBody.kind, "MultipartBody");
  });

  it("parses use declarations inside blockstate sections", () => {
    const module = parseRsgl([
      "blockstate minecraft:stairs {",
      "  variants {",
      "    use stairs(base: minecraft:block/stairs, inner: minecraft:block/stairs_inner, outer: minecraft:block/stairs_outer)",
      "  }",
      "}",
      "blockstate minecraft:fence {",
      "  multipart {",
      "    use fence(post: minecraft:block/fence_post, side: minecraft:block/fence_side)",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const stairs = module.statements[0];
    const fence = module.statements[1];
    assert.strictEqual(stairs.kind, "ResourceDecl");
    assert.strictEqual(fence.kind, "ResourceDecl");
    if (stairs.kind !== "ResourceDecl" || fence.kind !== "ResourceDecl") {
      throw new Error("Expected blockstate resources.");
    }
    const variants = stairs.body.statements[0];
    const multipart = fence.body.statements[0];
    assert.strictEqual(variants.kind, "VariantsSection");
    assert.strictEqual(multipart.kind, "MultipartSection");
    if (variants.kind !== "VariantsSection" || multipart.kind !== "MultipartSection") {
      throw new Error("Expected blockstate sections.");
    }
    assert.strictEqual(variants.entries[0].kind, "UseDecl");
    assert.strictEqual(multipart.entries[0].kind, "UseDecl");
  });

  it("recovers from syntax errors and reports actionable diagnostics", () => {
    const module = parseRsgl([
      "target java format [88, 0]",
      "blockstate minecraft:example {",
      "  variants {",
      "    {} -> { model: minecraft:block/example }",
      "  }",
      "  multipart {",
      "    apply { model: minecraft:block/example }",
      "  }",
      "}",
      "model block broken {",
      "  parent",
      "  textures { all: minecraft:block/example }"
    ].join("\n"));

    const codes = module.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.blockstateSectionConflict"));
    assert.ok(codes.includes("rsgl.expectedPropertyValue"));
    assert.ok(codes.includes("rsgl.expectedClosingBrace"));
  });

  it("recovers from blockstate entry blocks that are missing separators", () => {
    const module = parseRsgl([
      "blockstate minecraft:legacy_variants {",
      "  variants {",
      "    `age=${age}` {",
      "      @`minecraft:block/crop_${age}`",
      "    }",
      "  }",
      "}",
      "blockstate minecraft:legacy_multipart {",
      "  multipart {",
      "    {",
      "      @minecraft:block/base",
      "    }",
      "    when { distance: 1 } {",
      "      @minecraft:block/distance_1",
      "    }",
      "  }",
      "}"
    ].join("\n"));

    const codes = module.diagnostics.map(diagnostic => diagnostic.code);
    assert.strictEqual(module.statements.length, 2);
    assert.ok(codes.filter(code => code === "rsgl.expectedToken").length >= 3);
  });

  it("recovers from common incomplete editor states", () => {
    const snippets = [
      "template cube(",
      "model block stone {\n  textures {\n    all:",
      "blockstate minecraft:crop {\n  variants {\n    `age=0` {",
      "item bow {\n  select property minecraft:potion_contents {\n    case",
      "let values = [north,",
      "let table = { key:"
    ];

    for (const snippet of snippets) {
      const module = parseRsgl(snippet);
      assert.ok(module.diagnostics.some(diagnostic => diagnostic.severity === "error"));
      assert.strictEqual(module.eof.kind, "endOfFile");
    }
  });
});
