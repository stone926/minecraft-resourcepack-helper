import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  compileRsglProgram,
  type JsonValue,
  type ResourceUnit,
  type RsglCompileResult
} from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { compileSource, expectNoDiagnostics, expectOnlyLegacyTemplateWarnings } from "./helpers/compile";
import { createTempDir } from "./helpers/fs";

describe("RSGL extern declarations", () => {
  it("matches exact, listed, shallow, recursive, and namespace-wildcard patterns lazily", () => {
    const existenceChecks: Array<[string, string, string]> = [];
    const result = compileSource([
      "extern custom texture minecraft:block/exact, minecraft:item/listed",
      "extern custom texture minecraft:block/wood/*",
      "extern custom texture minecraft:entity/**",
      "extern custom texture *:shared",
      "model block references {",
      "  textures {",
      "    exact: minecraft:block/exact",
      "    listed: minecraft:item/listed",
      "    shallow: minecraft:block/wood/oak",
      "    recursive_one: minecraft:entity/zombie",
      "    recursive_deep: minecraft:entity/zombie/outer/layer",
      "    any_namespace: example:shared",
      "  }",
      "}"
    ], {
      externResourceExists: (source, kind, id) => {
        existenceChecks.push([source, kind, id]);
        return true;
      }
    });

    expectNoDiagnostics(result);
    const expectedIds = [
      "example:shared",
      "minecraft:block/exact",
      "minecraft:block/wood/oak",
      "minecraft:entity/zombie",
      "minecraft:entity/zombie/outer/layer",
      "minecraft:item/listed"
    ];
    assert.deepStrictEqual(
      externalUnits(result).map(unit => unit.external!.id).sort(),
      expectedIds
    );
    assert.deepStrictEqual(
      existenceChecks.sort((left, right) => left[2].localeCompare(right[2])),
      expectedIds.map(id => ["custom", "texture", id])
    );
  });

  it("keeps a single-segment wildcard from matching nested paths", () => {
    const result = compileSource([
      "extern! custom texture minecraft:block/wood/*",
      "model block references {",
      "  textures {",
      "    shallow: minecraft:block/wood/oak",
      "    nested: minecraft:block/wood/oak/planks",
      "  }",
      "}"
    ]);

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.undeclaredExternalResource"
    ]);
    assert.deepStrictEqual(
      externalUnits(result).map(unit => unit.external!.id),
      ["minecraft:block/wood/oak"]
    );
  });

  it("skips existence resolution for extern! and the global existence switch", () => {
    const unchecked = compileSource([
      "extern! vanilla model minecraft:block/unchecked",
      ...blockstateUsing("unchecked", "minecraft:block/unchecked")
    ]);
    const globallyUnchecked = compileSource([
      "extern custom model minecraft:block/globally_unchecked",
      ...blockstateUsing("globally_unchecked", "minecraft:block/globally_unchecked")
    ], { checkExternExistence: false });

    for (const result of [unchecked, globallyUnchecked]) {
      expectNoDiagnostics(result);
      assert.strictEqual(externalUnits(result).length, 1);
      assert.strictEqual(externalUnits(result)[0].external?.skipExistenceCheck, true);
    }
  });

  it("lets a global extern entry opt back into checks when the top-level switch is off", () => {
    let checks = 0;
    const result = compileSource(blockstateUsing("checked_override", "minecraft:block/checked_override"), {
      checkExternExistence: false,
      globalExterns: [{
        source: "custom",
        kind: "model",
        patterns: ["minecraft:block/checked_override"],
        checkExistence: true
      }],
      externResourceExists: () => {
        checks++;
        return false;
      }
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), ["rsgl.modelNotFound"]);
    assert.strictEqual(checks, 1);
    assert.strictEqual(externalUnits(result)[0].external?.skipExistenceCheck, false);
  });

  it("rejects a physically available resource that has no matching extern declaration", () => {
    let physicalResolverCalls = 0;
    const result = compileSource(blockstateUsing("stone", "minecraft:block/stone"), {
      resourceExists: () => {
        physicalResolverCalls++;
        return true;
      },
      externResourceExists: () => {
        physicalResolverCalls++;
        return true;
      }
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      severity: diagnostic.severity
    })), [{
      code: "rsgl.undeclaredExternalResource",
      severity: "error"
    }]);
    assert.strictEqual(physicalResolverCalls, 0);
    assert.deepStrictEqual(externalUnits(result), []);
  });

  it("treats generated target-path resources as internal without extern declarations", () => {
    const root = createTempDir("rsgl-generated-extern-");
    try {
      fs.writeFileSync(path.join(root, "generated.png"), Buffer.from([1, 2, 3]));
      const result = compileSource([
        "copy \"assets/minecraft/textures/block/generated.png\" {",
        "  from \"generated.png\"",
        "}",
        "model block generated_reference {",
        "  textures { all: minecraft:block/generated }",
        "}"
      ], { fileName: path.join(root, "main.rsgl") });

      expectNoDiagnostics(result);
      assert.deepStrictEqual(externalUnits(result), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records concrete transitive external model dependencies without expanding declarations", () => {
    const dependencyRoot = path.resolve("external-dependencies");
    const externalModels = new Map<string, Record<string, JsonValue>>([
      ["minecraft:block/external_child", {
        parent: "minecraft:block/external_root",
        textures: { alias: "#root" }
      }],
      ["minecraft:block/external_root", {
        textures: { root: "minecraft:block/external_texture" }
      }]
    ]);
    const result = compileSource([
      "extern custom model minecraft:block/external_child",
      "model block local_child {",
      "  parent minecraft:block/external_child",
      "  textures { all: \"#alias\" }",
      "}"
    ], {
      externResourcePath: (_source, kind, id) =>
        path.join(dependencyRoot, kind, id.replace(":", "_")),
      externResourceContent: (_source, kind, id) => {
        assert.strictEqual(kind, "model");
        return externalModels.get(id);
      }
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result).map(unit => unit.external!.id).sort(),
      [
        "minecraft:block/external_child",
        "minecraft:block/external_root",
        "minecraft:block/external_texture"
      ]
    );
    assert.deepStrictEqual(
      result.dependencies.map(dependency => dependency.reason),
      ["extern", "extern", "extern", "extern"]
    );
    assert.strictEqual(
      result.dependencies.filter(dependency => dependency.path.includes("external_texture")).length,
      2,
      "the inherited definition and local texture-variable use retain separate source origins"
    );
  });

  it("prefers file-local declarations and falls back to global declarations", () => {
    const fileName = path.resolve("pack", "scope.rsgl");
    const local = compileSource([
      "extern custom model minecraft:block/stone",
      ...blockstateUsing("local", "minecraft:block/stone")
    ], {
      fileName,
      globalExterns: [{
        source: "vanilla",
        kind: "model",
        patterns: ["minecraft:block/stone"],
        checkExistence: false
      }],
      externResourceExists: source => source === "custom"
    });
    const global = compileSource(blockstateUsing("global", "minecraft:block/stone"), {
      fileName,
      globalExterns: [{
        source: "vanilla",
        kind: "model",
        patterns: ["minecraft:block/stone"]
      }],
      externResourceExists: source => source === "vanilla"
    });

    expectNoDiagnostics(local);
    expectNoDiagnostics(global);
    assert.strictEqual(externalUnits(local)[0].external?.source, "custom");
    assert.strictEqual(externalUnits(local)[0].external?.skipExistenceCheck, false);
    assert.strictEqual(externalUnits(global)[0].external?.source, "vanilla");
  });

  it("prefers custom over vanilla for equally specific declarations", () => {
    const existenceChecks: string[] = [];
    const result = compileSource([
      "extern vanilla model minecraft:block/stone",
      "extern custom model minecraft:block/stone",
      ...blockstateUsing("overridden", "minecraft:block/stone")
    ], {
      externResourceExists: source => {
        existenceChecks.push(source);
        return source === "custom";
      }
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(existenceChecks, ["custom"]);
    assert.strictEqual(externalUnits(result)[0].external?.source, "custom");
  });

  it("selects the most specific matching declaration", () => {
    const result = compileSource([
      "extern! custom model minecraft:block/**",
      "extern! vanilla model minecraft:block/stone",
      ...blockstateUsing("specific", "minecraft:block/stone")
    ]);

    expectNoDiagnostics(result);
    assert.strictEqual(externalUnits(result)[0].external?.source, "vanilla");
  });

  it("does not propagate a file-local extern through imports", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const libraryFile = path.resolve("pack", "library.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import \"./library.rsgl\"",
          ...blockstateUsing("stolen", "minecraft:block/library_only")
        ].join("\n"))
      },
      {
        fileName: libraryFile,
        module: parseRsgl("extern! vanilla model minecraft:block/library_only")
      }
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.undeclaredExternalResource"
    ]);
    assert.deepStrictEqual(externalUnits(result), []);
  });

  it("treats declarations nested in top-level template blocks as file-scoped", () => {
    const mainFile = path.resolve("pack", "nested-main.rsgl");
    const templatesFile = path.resolve("pack", "nested-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { generatedBlockstate } from \"./nested-templates.rsgl\"",
          "use generatedBlockstate()"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template generatedBlockstate() {",
          "  extern! vanilla model minecraft:block/template_model",
          "  blockstate generated {",
          "    variants { {} -> { model: minecraft:block/template_model } }",
          "  }",
          "}",
          "export { generatedBlockstate }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.strictEqual(externalUnits(result)[0].external?.source, "vanilla");
  });

  it("attributes imported fixed-reference diagnostics to definitions and argument diagnostics to callers", () => {
    const mainFile = path.resolve("pack", "diagnostic-main.rsgl");
    const templatesFile = path.resolve("pack", "diagnostic-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { scopedModels } from \"./diagnostic-templates.rsgl\"",
          "blockstate scoped { use scopedModels(minecraft:block/caller_missing) }"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template scopedModels(callerModel: ModelId) -> variants {",
          "    {} -> [",
          "      { model: minecraft:block/fixed_missing },",
          "      { model: callerModel }",
          "    ]",
          "}",
          "export { scopedModels }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    const externDiagnostics = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.undeclaredExternalResource"
    );
    assert.strictEqual(externDiagnostics.length, 2);
    assert.strictEqual(
      externDiagnostics.find(diagnostic => diagnostic.message.includes("fixed_missing"))?.fileName,
      templatesFile
    );
    assert.strictEqual(
      externDiagnostics.find(diagnostic => diagnostic.message.includes("caller_missing"))?.fileName,
      mainFile
    );
  });

  it("uses definition-file externs for fixed template references and caller externs for arguments", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { modelVariant } from \"./templates.rsgl\"",
          "extern! custom model minecraft:block/caller_model",
          "blockstate fixed_reference { use modelVariant() }",
          "blockstate caller_argument { use modelVariant(minecraft:block/caller_model) }"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla model minecraft:block/library_model",
          "template modelVariant(modelId: ModelId = minecraft:block/library_model) -> variants {",
          "  {} -> { model: modelId }",
          "}",
          "export { modelVariant }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result)
        .map(unit => [unit.external!.id, unit.external!.source])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        ["minecraft:block/caller_model", "custom"],
        ["minecraft:block/library_model", "vanilla"]
      ]
    );
  });

  it("preserves caller extern scope when a template argument is assigned to a local", () => {
    const mainFile = path.resolve("pack", "alias-main.rsgl");
    const templatesFile = path.resolve("pack", "alias-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { aliasedModel } from \"./alias-templates.rsgl\"",
          "extern! custom model minecraft:block/caller_model",
          "use aliasedModel(minecraft:block/caller_model)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template aliasedModel(callerModel: ModelId) {",
          "  blockstate aliased {",
          "    let alias = callerModel",
          "    variants { {} -> { model: alias } }",
          "  }",
          "}",
          "export { aliasedModel }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result).map(unit => [unit.external!.id, unit.external!.source]),
      [["minecraft:block/caller_model", "custom"]]
    );
  });

  it("keeps mixed fixed and argument references in their respective lexical extern scopes", () => {
    const mainFile = path.resolve("pack", "mixed-main.rsgl");
    const templatesFile = path.resolve("pack", "mixed-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { mixedModels } from \"./mixed-templates.rsgl\"",
          "extern! custom model minecraft:block/caller_model",
          "blockstate mixed { use mixedModels(minecraft:block/caller_model) }"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla model minecraft:block/library_model",
          "template mixedModels(callerModel: ModelId) -> variants {",
          "    {} -> [",
          "      { model: minecraft:block/library_model },",
          "      { model: callerModel }",
          "    ]",
          "}",
          "export { mixedModels }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result)
        .map(unit => [unit.external!.id, unit.external!.source])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        ["minecraft:block/caller_model", "custom"],
        ["minecraft:block/library_model", "vanilla"]
      ]
    );
    const blockstate = result.units.find(unit => !unit.external && unit.kind === "blockstate");
    assert.ok(blockstate?.sourceMap.mappings
      .filter(mapping => mapping.generatedPath.startsWith("/variants"))
      .every(mapping => mapping.sourceFile === templatesFile));
  });

  it("preserves lexical extern scopes inside mixed merge expressions", () => {
    const mainFile = path.resolve("pack", "merge-main.rsgl");
    const templatesFile = path.resolve("pack", "merge-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { mixedItemModels } from \"./merge-templates.rsgl\"",
          "extern! custom model minecraft:item/caller_model",
          "item mixed { use mixedItemModels(minecraft:item/caller_model) }"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla model minecraft:item/library_model",
          "template mixedItemModels(callerModel: ModelId) {",
          "  merge {",
          "    model: {",
          "      type: minecraft:composite,",
          "      models: [",
          "        { type: minecraft:model, model: minecraft:item/library_model },",
          "        { type: minecraft:model, model: callerModel }",
          "      ]",
          "    }",
          "  }",
          "}",
          "export { mixedItemModels }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectOnlyLegacyTemplateWarnings(result);
    assert.deepStrictEqual(
      externalUnits(result)
        .map(unit => [unit.external!.id, unit.external!.source])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        ["minecraft:item/caller_model", "custom"],
        ["minecraft:item/library_model", "vanilla"]
      ]
    );
  });

  it("uses caller extern scope for imported specialized item statements", () => {
    const mainFile = path.resolve("pack", "item-main.rsgl");
    const templatesFile = path.resolve("pack", "item-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { layeredItem } from \"./item-templates.rsgl\"",
          "extern! custom model minecraft:item/caller_layer",
          "item layered { use layeredItem(minecraft:item/caller_layer) }"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla model minecraft:item/library_layer",
          "template layeredItem(callerModel: ModelId) {",
          "  composite {",
          "    model minecraft:item/library_layer",
          "    model callerModel",
          "  }",
          "}",
          "export { layeredItem }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectOnlyLegacyTemplateWarnings(result);
    assert.deepStrictEqual(
      externalUnits(result)
        .map(unit => [unit.external!.id, unit.external!.source])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        ["minecraft:item/caller_layer", "custom"],
        ["minecraft:item/library_layer", "vanilla"]
      ]
    );
  });

  it("uses caller extern scope for imported model impl arguments", () => {
    const mainFile = path.resolve("pack", "impl-main.rsgl");
    const templatesFile = path.resolve("pack", "impl-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { implModel } from \"./impl-templates.rsgl\"",
          "extern! custom model minecraft:block/caller_parent",
          "extern! custom texture minecraft:block/caller_texture",
          "use implModel(test, minecraft:block/caller_parent, minecraft:block/caller_texture)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template implModel(id: ResourceId, parentModel: ModelId, texture: TextureId) {",
          "  model block id impl parentModel(all: texture) {}",
          "}",
          "export { implModel }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result).map(unit => [unit.external!.id, unit.external!.source]).sort(),
      [
        ["minecraft:block/caller_parent", "custom"],
        ["minecraft:block/caller_texture", "custom"]
      ]
    );
    const model = result.units.find(unit => !unit.external && unit.kind === "model");
    assert.ok(model?.sourceMap.mappings
      .filter(mapping => mapping.generatedPath === "/parent" || mapping.generatedPath === "/textures/all")
      .every(mapping => mapping.sourceFile === templatesFile));
  });

  it("preserves caller extern scope through dependent defaults and local aliases", () => {
    const mainFile = path.resolve("pack", "derived-main.rsgl");
    const templatesFile = path.resolve("pack", "derived-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { derivedModel } from \"./derived-templates.rsgl\"",
          "extern! custom texture minecraft:block/caller_texture",
          "use derivedModel(test, minecraft:block/caller_texture)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template derivedModel(id: ResourceId, texture: TextureId, inherited: TextureId = texture) {",
          "  let alias = inherited",
          "  model block id { textures { all: alias } }",
          "}",
          "export { derivedModel }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(externalUnits(result).map(unit => unit.external), [{
      kind: "external",
      resourceKind: "texture",
      id: "minecraft:block/caller_texture",
      source: "custom",
      skipExistenceCheck: true
    }]);
  });

  it("uses a generated parent model's definition-file extern scope", () => {
    const mainFile = path.resolve("pack", "parent-main.rsgl");
    const templatesFile = path.resolve("pack", "parent-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { makeParent } from \"./parent-templates.rsgl\"",
          "use makeParent()",
          "model block child {",
          "  parent minecraft:block/generated_parent",
          "  textures { particle: \"#all\" }",
          "}"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla texture minecraft:block/library_texture",
          "template makeParent() {",
          "  model block generated_parent {",
          "    textures { all: minecraft:block/library_texture }",
          "  }",
          "}",
          "export { makeParent }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result).map(unit => [unit.external!.id, unit.external!.source]),
      [["minecraft:block/library_texture", "vanilla"]]
    );
  });

  it("treats generated textures reached through external model variables as internal", () => {
    const root = createTempDir("rsgl-generated-inherited-texture-");
    try {
      fs.writeFileSync(path.join(root, "generated.png"), Buffer.from([1, 2, 3]));
      const externalModelPath = path.join(root, "external_parent.json");
      const result = compileSource([
        "extern custom model minecraft:block/external_parent",
        "copy \"assets/minecraft/textures/block/generated.png\" {",
        "  from \"generated.png\"",
        "}",
        "model block child {",
        "  parent minecraft:block/external_parent",
        "  textures { all: \"#inherited\" }",
        "}"
      ], {
        fileName: path.join(root, "main.rsgl"),
        externResourcePath: (_source, kind, id) =>
          kind === "model" && id === "minecraft:block/external_parent"
            ? externalModelPath
            : null,
        externResourceContent: (_source, kind, id) =>
          kind === "model" && id === "minecraft:block/external_parent"
            ? { textures: { inherited: "minecraft:block/generated" } }
            : undefined
      });

      expectNoDiagnostics(result);
      assert.deepStrictEqual(
        externalUnits(result).map(unit => [unit.external!.resourceKind, unit.external!.id]),
        [["model", "minecraft:block/external_parent"]]
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves fixed and caller extern scopes for generic typed-resource validators", () => {
    const mainFile = path.resolve("pack", "generic-scope-main.rsgl");
    const templatesFile = path.resolve("pack", "generic-scope-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { fontFields, soundFields, waypointFields, postFields } from \"./generic-scope-templates.rsgl\"",
          "extern! custom font_file minecraft:font/caller.ttf",
          "extern! custom sound minecraft:caller/sound",
          "extern! custom texture minecraft:gui/sprites/hud/locator_bar_dot/caller_sprite, minecraft:effect/caller_mask",
          "extern! custom shader_vertex minecraft:caller/vertex",
          "extern! custom shader_fragment minecraft:caller/fragment",
          "font scoped_font { use fontFields(minecraft:font/caller.ttf) }",
          "sounds minecraft { use soundFields(minecraft:caller/sound) }",
          "waypoint_style scoped_waypoint { use waypointFields(minecraft:caller_sprite) }",
          "post_effect scoped_post { use postFields(minecraft:caller/vertex, minecraft:caller/fragment, minecraft:caller_mask) }"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla font_file minecraft:font/library.ttf",
          "extern! vanilla sound minecraft:library/sound",
          "extern! vanilla texture minecraft:gui/sprites/hud/locator_bar_dot/library_sprite, minecraft:effect/library_mask",
          "extern! vanilla shader_vertex minecraft:library/vertex",
          "extern! vanilla shader_fragment minecraft:library/fragment",
          "template fontFields(file: ResourceId) {",
          "  providers [{ type: ttf, file: minecraft:font/library.ttf }, { type: ttf, file: file }]",
          "}",
          "template soundFields(sound: ResourceId) {",
          "  \"scope.event\" { sounds: [minecraft:library/sound, sound] }",
          "}",
          "template waypointFields(sprite: ResourceId) {",
          "  sprites [minecraft:library_sprite, sprite]",
          "}",
          "template postFields(vertex: ResourceId, fragment: ResourceId, mask: ResourceId) {",
          "  passes [",
          "    { vertex_shader: minecraft:library/vertex, fragment_shader: minecraft:library/fragment, inputs: [{ sampler_name: \"Fixed\", location: minecraft:library_mask }] },",
          "    { vertex_shader: vertex, fragment_shader: fragment, inputs: [{ sampler_name: \"Caller\", location: mask }] }",
          "  ]",
          "}",
          "export { fontFields, soundFields, waypointFields, postFields }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectOnlyLegacyTemplateWarnings(result, 4);
    const resources = externalUnits(result).map(unit => unit.external!);
    assert.strictEqual(resources.length, 12);
    assert.ok(resources
      .filter(resource => resource.id.includes("library"))
      .every(resource => resource.source === "vanilla"));
    assert.ok(resources
      .filter(resource => resource.id.includes("caller"))
      .every(resource => resource.source === "custom"));
  });

  it("keeps extension-bearing bitmap texture ids canonical in extern and generated resources", () => {
    const external = compileSource([
      "extern! custom texture minecraft:font/ascii.png",
      "font default {",
      "  providers [{ type: bitmap, file: minecraft:font/ascii.png, ascent: 7, chars: [\"abc\"] }]",
      "}"
    ]);

    expectNoDiagnostics(external);
    assert.deepStrictEqual(
      externalUnits(external).map(unit => [unit.external!.id, unit.outputPath]),
      [["minecraft:font/ascii.png", "assets/minecraft/textures/font/ascii.png"]]
    );

    const root = createTempDir("rsgl-generated-font-bitmap-");
    try {
      fs.writeFileSync(path.join(root, "ascii.png"), Buffer.from([1, 2, 3]));
      const generated = compileSource([
        "copy \"assets/minecraft/textures/font/ascii.png\" { from \"ascii.png\" }",
        "font default {",
        "  providers [{ type: bitmap, file: minecraft:font/ascii.png, ascent: 7, chars: [\"abc\"] }]",
        "}"
      ], { fileName: path.join(root, "main.rsgl") });

      expectNoDiagnostics(generated);
      assert.deepStrictEqual(externalUnits(generated), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies the global existence switch to inherited external model dependencies", () => {
    const existenceChecks: string[] = [];
    const result = compileSource([
      "extern custom model minecraft:block/external_child",
      "model block local_child { parent minecraft:block/external_child }"
    ], {
      checkExternExistence: false,
      resourceContent: (_kind, id) => id === "minecraft:block/external_child"
        ? { parent: "minecraft:block/transitive_parent" }
        : undefined,
      resourceExists: (kind, id) => {
        existenceChecks.push(`${kind}:${id}`);
        return false;
      }
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(existenceChecks, []);
    assert.deepStrictEqual(
      externalUnits(result).map(unit => [unit.external!.id, unit.external!.skipExistenceCheck]),
      [
        ["minecraft:block/external_child", true],
        ["minecraft:block/transitive_parent", true]
      ]
    );
  });
});

function externalUnits(result: RsglCompileResult): ResourceUnit[] {
  return result.units.filter(unit => unit.external !== undefined);
}

function blockstateUsing(id: string, model: string): string[] {
  return [
    `blockstate ${id} {`,
    `  variants { {} -> { model: ${model} } }`,
    "}"
  ];
}
