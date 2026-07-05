import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { getRsglCompletionCandidates } from "../../../packages/rsgl-core/src/completionData";
import { formatRsglText } from "../../../packages/rsgl-core/src/formatterCore";
import { lexRsgl, parseRsgl } from "../../../packages/rsgl-core/src/parser";
import { resourceKeywords } from "../../../packages/rsgl-core/src/parser/keywords";
import { rsglResourceKinds } from "../../../packages/rsgl-core/src/resourceKinds";
import { discoverRsglSourceRootsFromFileNames, resolveRsglSourceRootFromFileName, RsglWorkspaceSourceRootCache } from "../../../packages/rsgl-core/src/sourceRoot";

describe("RSGL language", () => {
  it("contributes the rsgl language and bundled editor assets", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      activationEvents?: string[];
      extensionDependencies?: string[];
      contributes?: {
        commands?: Array<{ command?: string; icon?: string }>;
        languages?: Array<{ id?: string; extensions?: string[]; configuration?: string }>;
        grammars?: Array<{ language?: string; path?: string; scopeName?: string }>;
        menus?: Record<string, Array<{ command?: string; when?: string }>>;
      };
    };
    const rsglPackageRoot = path.join(process.cwd(), "extensions", "vscode-rsgl");
    const rsglPackageJson = JSON.parse(fs.readFileSync(path.join(rsglPackageRoot, "package.json"), "utf8")) as typeof packageJson;

    assert.ok(packageJson.extensionDependencies?.includes("stone926.rsgl"));
    assert.strictEqual(packageJson.contributes?.languages?.some(entry => entry.id === "rsgl"), false);
    assert.ok(packageJson.activationEvents?.includes("onCommand:McResHelper.buildRsglResourcePack"));
    assert.ok(packageJson.activationEvents?.includes("onCommand:McResHelper.previewRsglResourcePackBuild"));
    assert.ok(packageJson.activationEvents?.includes("onCommand:McResHelper.buildRsglResourcePackDirectory"));
    assert.ok(packageJson.activationEvents?.includes("onCommand:McResHelper.previewRsglResourcePackDirectoryBuild"));
    assert.ok(packageJson.activationEvents?.includes("onCommand:McResHelper.buildRsglWorkspaceResourcePacks"));
    assert.ok(packageJson.activationEvents?.includes("onCommand:McResHelper.previewRsglWorkspaceResourcePackBuilds"));

    assert.ok(rsglPackageJson.activationEvents?.includes("onLanguage:rsgl"));
    assert.ok(rsglPackageJson.activationEvents?.includes("onCommand:rsgl.build"));
    assert.ok(rsglPackageJson.activationEvents?.includes("onCommand:rsgl.previewBuild"));
    assert.ok(rsglPackageJson.activationEvents?.includes("onCommand:rsgl.buildDirectory"));
    assert.ok(rsglPackageJson.activationEvents?.includes("onCommand:rsgl.previewDirectoryBuild"));
    assert.ok(rsglPackageJson.activationEvents?.includes("onCommand:rsgl.buildWorkspace"));
    assert.ok(rsglPackageJson.activationEvents?.includes("onCommand:rsgl.previewWorkspaceBuild"));

    const language = rsglPackageJson.contributes?.languages?.find(entry => entry.id === "rsgl");
    assert.ok(language);
    assert.ok(language.extensions?.includes(".rsgl"));
    assert.ok(language.configuration);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(rsglPackageRoot, language.configuration!), "utf8")));

    const grammar = rsglPackageJson.contributes?.grammars?.find(entry => entry.language === "rsgl");
    assert.strictEqual(grammar?.scopeName, "source.rsgl");
    assert.ok(grammar.path);
    const grammarJson = JSON.parse(fs.readFileSync(path.join(rsglPackageRoot, grammar.path!), "utf8")) as unknown;
    for (const kind of rsglResourceKinds) {
      assert.ok(JSON.stringify(grammarJson).includes(kind), `Expected RSGL grammar to include resource kind '${kind}'.`);
    }

    assert.ok(packageJson.contributes?.commands?.some(command =>
      command.command === "McResHelper.buildRsglResourcePack" && command.icon === "$(play)"
    ));
    assert.ok(packageJson.contributes?.commands?.some(command =>
      command.command === "McResHelper.previewRsglResourcePackBuild" && command.icon === "$(diff)"
    ));
    assert.ok(packageJson.contributes?.commands?.some(command =>
      command.command === "McResHelper.buildRsglResourcePackDirectory" && command.icon === "$(run-all)"
    ));
    assert.ok(packageJson.contributes?.commands?.some(command =>
      command.command === "McResHelper.previewRsglResourcePackDirectoryBuild" && command.icon === "$(diff)"
    ));
    assert.ok(packageJson.contributes?.commands?.some(command =>
      command.command === "McResHelper.buildRsglWorkspaceResourcePacks" && command.icon === "$(run-all)"
    ));
    assert.ok(packageJson.contributes?.commands?.some(command =>
      command.command === "McResHelper.previewRsglWorkspaceResourcePackBuilds" && command.icon === "$(diff)"
    ));

    assert.ok(rsglPackageJson.contributes?.commands?.some(command =>
      command.command === "rsgl.build" && command.icon === "$(play)"
    ));
    assert.ok(rsglPackageJson.contributes?.commands?.some(command =>
      command.command === "rsgl.previewBuild" && command.icon === "$(diff)"
    ));
    assert.ok(rsglPackageJson.contributes?.commands?.some(command =>
      command.command === "rsgl.buildDirectory" && command.icon === "$(run-all)"
    ));
    assert.ok(rsglPackageJson.contributes?.commands?.some(command =>
      command.command === "rsgl.previewDirectoryBuild" && command.icon === "$(diff)"
    ));
    assert.ok(rsglPackageJson.contributes?.commands?.some(command =>
      command.command === "rsgl.buildWorkspace" && command.icon === "$(run-all)"
    ));
    assert.ok(rsglPackageJson.contributes?.commands?.some(command =>
      command.command === "rsgl.previewWorkspaceBuild" && command.icon === "$(diff)"
    ));
    assert.ok(rsglPackageJson.contributes?.menus?.["editor/title"]?.some(item =>
      item.command === "rsgl.build" && item.when === "resourceLangId == rsgl"
    ));
    assert.ok(rsglPackageJson.contributes?.menus?.["editor/title"]?.some(item =>
      item.command === "rsgl.previewBuild" && item.when === "resourceLangId == rsgl"
    ));
    assert.ok(rsglPackageJson.contributes?.menus?.["editor/context"]?.some(item =>
      item.command === "rsgl.buildDirectory" && item.when === "resourceLangId == rsgl"
    ));
    assert.ok(rsglPackageJson.contributes?.menus?.["editor/context"]?.some(item =>
      item.command === "rsgl.previewDirectoryBuild" && item.when === "resourceLangId == rsgl"
    ));
  });

  it("resolves an RSGL source root from active file paths", () => {
    const sourceRoot = path.resolve("pack", "src");
    assert.strictEqual(
      resolveRsglSourceRootFromFileName(path.join(sourceRoot, "main.rsgl")),
      sourceRoot
    );
    assert.strictEqual(
      resolveRsglSourceRootFromFileName(path.join(sourceRoot, "nested", "blocks.rsgl")),
      sourceRoot
    );
    assert.strictEqual(
      resolveRsglSourceRootFromFileName(path.resolve("pack", "rsgl", "blocks.rsgl")),
      path.resolve("pack", "rsgl")
    );

    assert.deepStrictEqual(
      discoverRsglSourceRootsFromFileNames([
        path.join(sourceRoot, "main.rsgl"),
        path.join(sourceRoot, "nested", "blocks.rsgl"),
        path.resolve("pack", ".vscode", "ignored.rsgl"),
        path.resolve("pack", "assets", "model.json"),
        path.resolve("other_pack", "src", "main.rsgl")
      ]).map(root => root.sourceRoot),
      [
        path.resolve("other_pack", "src"),
        sourceRoot
      ].sort()
    );
  });

  it("caches RSGL workspace source root discovery until RSGL files change", async () => {
    const sourceRoot = path.resolve("pack", "src");
    const cache = new RsglWorkspaceSourceRootCache();
    let calls = 0;
    const provider = () => {
      calls++;
      return [
        path.join(sourceRoot, "main.rsgl"),
        path.join(sourceRoot, "nested", "blocks.rsgl")
      ];
    };

    assert.deepStrictEqual((await cache.discover(provider)).map(root => root.sourceRoot), [sourceRoot]);
    assert.deepStrictEqual((await cache.discover(provider)).map(root => root.sourceRoot), [sourceRoot]);
    assert.strictEqual(calls, 1);

    cache.invalidatePath(path.resolve("pack", "assets", "models", "block", "stone.json"));
    assert.deepStrictEqual((await cache.discover(provider)).map(root => root.sourceRoot), [sourceRoot]);
    assert.strictEqual(calls, 1);

    cache.invalidatePath(path.join(sourceRoot, "new.rsgl"));
    assert.deepStrictEqual((await cache.discover(provider)).map(root => root.sourceRoot), [sourceRoot]);
    assert.strictEqual(calls, 2);
  });

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

  it("lexes comments, strings, numbers, and resource locations", () => {
    const result = lexRsgl([
      "// resource source",
      "target java format [88, 0]",
      "let texture = minecraft:block/acacia_planks",
      "let label = `minecraft:block/${wood}`"
    ].join("\n"));

    assert.deepStrictEqual(result.diagnostics, []);
    assert.ok(result.tokens.some(token => token.kind === "resourceLocation" && token.text === "minecraft:block/acacia_planks"));
    assert.ok(result.tokens.some(token => token.kind === "templateString"));
    assert.ok(result.tokens.some(token => token.kind === "number" && token.text === "88"));
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
      "stairs acacia_stairs"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(module.statements.length, 5);
    assert.deepStrictEqual(module.statements.map(statement => statement.kind), [
      "TargetDecl",
      "NamespaceDecl",
      "ImportDecl",
      "ResourceDecl",
      "SugarDecl"
    ]);

    const model = module.statements[3];
    assert.strictEqual(model.kind, "ResourceDecl");
    assert.strictEqual(model.resourceKind, "model");
    assert.strictEqual(model.subtype?.text, "block");
    assert.strictEqual(model.body.statements[0].kind, "PropertyStmt");
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

  it("parses resource body fragment declarations", () => {
    const module = parseRsgl([
      "fragment cubeFields(parentModel: ModelId, texture: TextureId) {",
      "  parent parentModel",
      "  textures { all: texture }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(module.statements.length, 1);
    const fragment = module.statements[0];
    assert.strictEqual(fragment.kind, "FragmentDecl");
    if (fragment.kind !== "FragmentDecl") {
      throw new Error("Expected fragment declaration.");
    }
    assert.strictEqual(fragment.name?.text, "cubeFields");
    assert.deepStrictEqual(fragment.parameters.map(parameter => parameter.name?.text), ["parentModel", "texture"]);
    assert.deepStrictEqual(fragment.body.statements.map(statement => statement.kind), ["PropertyStmt", "SectionStmt"]);
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

  it("parses override create and append resource fragments", () => {
    const module = parseRsgl([
      "model block patched {",
      "  parent minecraft:block/cube_all",
      "  override create { display: { gui: { scale: [1, 1, 1] } } }",
      "  append { textures: { particle: minecraft:block/stone } }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const model = module.statements[0];
    assert.strictEqual(model.kind, "ResourceDecl");
    if (model.kind !== "ResourceDecl") {
      throw new Error("Expected model resource declaration.");
    }
    assert.deepStrictEqual(model.body.statements.map(statement => statement.kind), [
      "PropertyStmt",
      "OverrideStmt",
      "AppendStmt"
    ]);
    const override = model.body.statements[1];
    assert.strictEqual(override.kind, "OverrideStmt");
    assert.strictEqual(override.kind === "OverrideStmt" ? override.create : false, true);
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

  it("provides top-level and block-aware completion candidates", () => {
    const topLevel = getRsglCompletionCandidates("", 0);
    assert.ok(topLevel.some(candidate => candidate.label === "target"));
    assert.ok(topLevel.some(candidate => candidate.label === "target mc"));
    assert.ok(topLevel.some(candidate => candidate.label === "export"));
    assert.ok(topLevel.some(candidate => candidate.label === "atlas"));
    assert.ok(topLevel.some(candidate => candidate.label === "particles"));
    assert.ok(topLevel.some(candidate => candidate.label === "equipment"));
    assert.ok(topLevel.some(candidate => candidate.label === "font"));
    assert.ok(topLevel.some(candidate => candidate.label === "waypoint_style"));
    assert.ok(topLevel.some(candidate => candidate.label === "post_effect"));
    assert.ok(topLevel.some(candidate => candidate.label === "lang"));
    assert.ok(topLevel.some(candidate => candidate.label === "sounds"));
    assert.ok(topLevel.some(candidate => candidate.label === "text"));
    assert.ok(topLevel.some(candidate => candidate.label === "copy"));
    assert.ok(topLevel.some(candidate => candidate.label === "cubeAll"));

    const inBlock = getRsglCompletionCandidates("model block stone {\n  ", "model block stone {\n  ".length);
    assert.ok(inBlock.some(candidate => candidate.label === "textures"));
    assert.ok(inBlock.some(candidate => candidate.label === "raw_json"));
  });

  it("formats indentation without changing source content inside strings", () => {
    const formatted = formatRsglText([
      "model block stone {",
      "parent minecraft:block/cube_all  ",
      "textures {",
      "all: `minecraft:block/${name}`",
      "}",
      "}"
    ].join("\n"));

    assert.strictEqual(formatted, [
      "model block stone {",
      "  parent minecraft:block/cube_all",
      "  textures {",
      "    all: `minecraft:block/${name}`",
      "  }",
      "}"
    ].join("\n"));
  });
});
